import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useSearchParams,
} from "react-router-dom";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  FloatingNode,
  FloatingPortal,
  FloatingTree,
  autoUpdate,
  flip,
  offset,
  safePolygon,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useFloatingNodeId,
  useRole,
} from "@floating-ui/react";
import { Check, ChevronDown, ChevronRight, CircleHelp, Copy, Database, ExternalLink, Info, Palette, Pencil, Plug, Search, ShieldCheck, Upload, X } from "lucide-react";
import { tracks, trackSources } from "./season.js";

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.detail || data.message || "Request failed");
  return data;
};

const states = {
  earned: "Earned",
  unearned: "Unearned",
  unknown: "Unavailable",
  in_progress: "In progress",
  completion_ready: "Ready to claim",
};
const rewardTypes = [
  ["decor", "Decor"], ["mount", "Mount"], ["pet", "Pet"],
  ["title", "Title"], ["toy", "Toy"], ["appearance", "Appearance"],
  ["gear", "Gear"], ["cache", "Cache / currency"],
  ["unlock", "Unlock"], ["other", "Other reward"], ["none", "No reward"],
];
const expansionReleaseOrder = [
  "Midnight",
  "The War Within",
  "Dragonflight",
  "Shadowlands",
  "Battle for Azeroth",
  "Legion",
  "Warlords of Draenor",
  "Mists of Pandaria",
  "Cataclysm",
  "Wrath of the Lich King",
  "The Burning Crusade",
  "Classic",
];
const expansionReleaseRank = new Map(expansionReleaseOrder.map((name, index) => [name, index]));
const colourPaletteKey = "wow-colour-palette-v1";
const trackerCacheTtlMs = 5 * 60 * 1000;
const trackerColumnSizingKey = "wow-tracker-column-sizes-v1";
const trackerSavedViewsKey = "wow-tracker-saved-views-v2";
const defaultPriorityLabels = [
  { priority: 100, label: "Do now" },
  { priority: 50, label: "This week" },
  { priority: 0, label: "Soon" },
  { priority: -50, label: "Someday" },
];

const formatEarnedAt = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "—";

function readColumnSizing() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(trackerColumnSizingKey));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        ([, value]) => typeof value === "number" && value >= 32 && value <= 900,
      ),
    );
  } catch {
    return {};
  }
}

function readSavedViews() {
  try {
    const views = JSON.parse(window.localStorage.getItem(trackerSavedViewsKey));
    return Array.isArray(views) ? views.filter((view) => view?.name && view?.state) : [];
  } catch {
    return [];
  }
}

function SavedViewsDialog({ views, onSave, onOpen, onDelete, onClose }) {
  const [name, setName] = useState("");
  useEffect(() => {
    const close = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="saved-views-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="saved-views-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-views-title">
        <header><div><span>SAVED FILTERS</span><h2 id="saved-views-title">Saved views</h2></div><button type="button" onClick={onClose} aria-label="Close saved views"><X size={16} /></button></header>
        <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) { onSave(name.trim()); setName(""); } }}>
          <label>View name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength="60" placeholder="e.g. Midnight mounts" /></label>
          <button type="submit" disabled={!name.trim()}>SAVE CURRENT VIEW</button>
        </form>
        <div className="saved-views-list">
          {views.length === 0 && <p>No saved views in this browser yet.</p>}
          {views.map((view) => <div key={view.name}><button type="button" onClick={() => onOpen(view)}><strong>{view.name}</strong><span>{view.state.status === "all" ? "All statuses" : states[view.state.status] || view.state.status}</span></button><button type="button" onClick={() => onDelete(view.name)} aria-label={`Delete saved view ${view.name}`}><X size={14} /></button></div>)}
        </div>
      </section>
    </div>
  );
}

function PriorityLegend({ labels }) {
  const legend = labels.length ? labels : defaultPriorityLabels;
  return (
    <span className="priority-legend" tabIndex="0" aria-label="Show priority scale">
      <CircleHelp size={15} strokeWidth={1.8} aria-hidden="true" />
      <span className="priority-legend-tooltip" role="tooltip">
        {legend.map(({ priority, label }) => (
          <span key={priority}>{priority}: {label}</span>
        ))}
      </span>
    </span>
  );
}

function priorityLabelFor(value, labels) {
  const scale = labels.length ? labels : defaultPriorityLabels;
  return [...scale].sort(
    (left, right) =>
      Math.abs(left.priority - value) - Math.abs(right.priority - value) ||
      right.priority - left.priority,
  )[0]?.label;
}

function priorityValueFor(value, labels) {
  const scale = labels.length ? labels : defaultPriorityLabels;
  return [...scale].sort(
    (left, right) =>
      Math.abs(left.priority - value) - Math.abs(right.priority - value) ||
      right.priority - left.priority,
  )[0]?.priority ?? 0;
}

function priorityOptionsFor(labels) {
  const scale = labels.length ? labels : defaultPriorityLabels;
  return [...scale].sort((left, right) => right.priority - left.priority);
}

function PriorityLegendEditor({ labels, onCancel, onSave }) {
  const [draft, setDraft] = useState(
    labels.length ? labels : defaultPriorityLabels,
  );
  const update = (index, key, value) =>
    setDraft((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, [key]: key === "priority" ? Number(value) : value }
          : item,
      ),
    );
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={onCancel}
    >
      <form
        className="grid w-full max-w-md gap-3 rounded border border-line bg-panel p-4 text-sm shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="priority-label-editor-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <div className="flex items-center justify-between">
          <h2 id="priority-label-editor-title" className="font-serif text-lg text-gold">Your priority labels</h2>
          <button className="text-muted hover:text-white" type="button" onClick={onCancel} aria-label="Close priority label editor">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {draft.map((item, index) => (
          <div className="flex items-center gap-2" key={`${item.priority}-${index}`}>
            <input
              className="tracker-cell-input w-16"
              type="number"
              min="-100"
              max="100"
              value={item.priority}
              onChange={(event) => update(index, "priority", event.target.value)}
              aria-label={`Priority value ${index + 1}`}
            />
            <input
              className="tracker-cell-input min-w-0 flex-1"
              value={item.label}
              maxLength="80"
              onChange={(event) => update(index, "label", event.target.value)}
              aria-label={`Priority label ${index + 1}`}
            />
            <button
              className="text-muted hover:text-white disabled:opacity-40"
              type="button"
              disabled={draft.length === 1}
              onClick={() => setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              aria-label={`Remove ${item.label || "priority label"}`}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <button className="tracker-button" type="submit">Save labels</button>
          <button className="tracker-button" type="button" onClick={onCancel}>Cancel</button>
          <button
            className="text-gold disabled:text-muted"
            type="button"
            disabled={draft.length >= 12}
            onClick={() => setDraft((current) => [...current, { priority: 25, label: "New label" }])}
          >
            Add label
          </button>
        </div>
      </form>
    </div>
  );
}

function PalettePicker() {
  const palettes = [
    { value: "gold", label: "Gold" },
    { value: "teal", label: "Teal" },
    { value: "purple", label: "Purple" },
  ];
  const [palette, setPalette] = useState(() => {
    try {
      const stored = window.localStorage.getItem(colourPaletteKey);
      return palettes.some((item) => item.value === stored) ? stored : "gold";
    } catch {
      return "gold";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    try { window.localStorage.setItem(colourPaletteKey, palette); } catch { /* storage is optional */ }
  }, [palette]);
  return (
    <label className="palette-picker" title="Colour palette">
      <Palette size={15} aria-hidden="true" />
      <span className="sr-only">Colour palette</span>
      <select value={palette} onChange={(event) => setPalette(event.target.value)} aria-label="Colour palette">
        {palettes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </label>
  );
}

function Shell({ children, right = null }) {
  return (
    <>
      <header className="site-nav">
        <nav>
          <span className="site-wordmark">
            CONSECRATED HAMMER
          </span>
          <NavLink to="/tracks">Upgrade tracks</NavLink>
          <NavLink to="/achievements">Achievement tracker</NavLink>
          <NavLink to="/hammerlink">HammerLink</NavLink>
          <NavLink to="/mcp-guide">MCP</NavLink>
          <span className="site-nav-right"><PalettePicker />{right}</span>
        </nav>
      </header>
      {children}
    </>
  );
}

const mcpEndpoint = "https://wow.batserver.au/mcp";
const mcpOauthClientId = "wow-mcp-shared";
const mcpCapabilityGroups = [
  {
    title: "Character and progression",
    note: "Live Blizzard profile data and curated season context. Read-only.",
    tools: [
      ["get_character_profile", "Identity, guild, item level, Mythic+ rating and recent runs."],
      ["get_character_equipment", "Current equipped items with upgrade-track resolution."],
      ["get_character_talents", "Active spec, hero tree, talent selections and import code."],
      ["get_character_achievements", "Achievement totals and recent completions from Blizzard."],
      ["list_realms", "Valid realm names and slugs by region."],
      ["get_raid_progress", "Character raid encounter completion by difficulty."],
      ["get_season_rewards", "Curated Season 2 rewards, Vault thresholds, crests and activities."],
      ["get_class_guidance", "Source-labelled ClassCodex recommendations and observed builds."],
      ["get_gear_audit", "Blizzard-equipped facts compared with contextual ClassCodex guidance."],
      ["get_mythic_planner", "Explainable Mythic+ reward targets for a character and goal."],
      ["get_meta_builds", "Observed Raider.IO builds with source and sample context."],
    ],
  },
  {
    title: "HammerLink inventory",
    note: "Private in-game snapshots belonging to the signed-in account. Read-only.",
    tools: [
      ["list_character_inventories", "List characters with saved HammerLink snapshots."],
      ["get_character_inventory", "Latest gear, bags, exact Vault state, currencies, owned decor and current quest log."],
    ],
  },
  {
    title: "Achievement tracker",
    note: "Reads and explicitly labelled updates to private Consecrated Hammer tracker state.",
    tools: [
      ["achievement_character_list", "List characters in the signed-in user's tracker."],
      ["achievement_list", "Search and order a character's achievement work queue."],
      ["achievement_compare", "Find achievement needs shared by two characters."],
      ["achievement_dashboard", "Summarise status counts and recent completions."],
      ["achievement_build_session_plan", "Build an explainable shared session queue."],
      ["achievement_priority_labels_get", "Read the signed-in user's priority legend."],
      ["achievement_character_upsert", "Add or reopen a tracked character. Updates tracker."],
      ["achievement_character_forget", "Remove a character from recents only. Updates tracker."],
      ["achievement_refresh_character", "Refresh recent Blizzard completions. Updates tracker."],
      ["achievement_set_priority", "Set a per-character achievement priority. Updates tracker."],
      ["achievement_priority_labels_set", "Replace the user's priority labels. Updates tracker."],
      ["achievement_update_state", "Record a manual achievement correction. Updates tracker."],
      ["achievement_set_curated_metadata", "Store verified, sourced achievement guidance. Updates tracker."],
    ],
  },
];

const mcpSuggestedPrompts = [
  "Using my latest HammerLink import, summarise my Great Vault progress and tell me what is still needed before reset.",
  "List my HammerLink characters, use the latest inventory for the one I name, and show capped currencies from lowest to highest upgrade tier.",
  "Audit my equipped gear. Keep Blizzard facts separate from ClassCodex recommendations and observed community builds.",
  "Compare two of my tracked characters and build a 45-minute achievement session containing things they both need.",
  "Show my achievement dashboard, then list the highest-priority unearned achievements. Do not change any tracker data.",
  "From my complete Housing decor export, suggest owned pieces that fit a gothic library theme. Say clearly if the export is incomplete.",
];

function McpGuide() {
  const [copied, setCopied] = useState(false);

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(mcpEndpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Shell>
      <main className="mcp-page">
        <section className="mcp-masthead">
          <div>
            <span className="ledger-eyebrow">PRIVATE WOW CONTEXT</span>
            <h1>Consecrated Hammer MCP</h1>
            <p>Connect ChatGPT or Claude to your character data, HammerLink snapshots, ClassCodex guidance and achievement tracker.</p>
          </div>
          <div className="mcp-endpoint" aria-label="MCP server address">
            <span>REMOTE MCP SERVER</span>
            <code>{mcpEndpoint}</code>
            <button type="button" onClick={copyEndpoint}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy URL"}</button>
            <div className="mcp-oauth-config"><span>OAuth client ID</span><code>{mcpOauthClientId}</code><small>Client secret: leave empty</small></div>
          </div>
        </section>

        <div className="mcp-content">
          <section className="mcp-intro" aria-labelledby="mcp-connect-heading">
            <span className="ledger-eyebrow">CONNECT ONCE</span>
            <h2 id="mcp-connect-heading">Add it to your assistant</h2>
            <p>The connection uses Authelia sign-in. Your account controls which private imports and tracker records the MCP can return.</p>
          </section>

          <div className="mcp-connect-grid">
            <article className="mcp-connect-card">
              <header><span className="mcp-service-mark">AI</span><div><h3>ChatGPT</h3><p>Custom app · ChatGPT web</p></div></header>
              <ol>
                <li>Open <strong>Settings → Apps</strong>. If required by your plan, enable <strong>Developer mode</strong> in Advanced Settings.</li>
                <li>Choose <strong>Create</strong>, name the app <strong>Consecrated Hammer</strong>, and paste the MCP URL above.</li>
                <li>For OAuth, enter client ID <code>{mcpOauthClientId}</code>. <strong>Leave the client secret empty</strong>—this is a public OAuth client and has no secret.</li>
                <li>Scan the tools, complete the Authelia sign-in, then create the app.</li>
                <li>In a new chat, select Consecrated Hammer from the tools menu for the message that needs fresh data.</li>
              </ol>
              <p className="mcp-plan-note">Full MCP apps are currently a Business, Enterprise and Edu web feature. Pro accounts can connect read/fetch MCP tools in developer mode; workspace permissions may restrict setup.</p>
              <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta" target="_blank" rel="noreferrer">Official ChatGPT instructions <ExternalLink size={13} /></a>
            </article>

            <article className="mcp-connect-card">
              <header><span className="mcp-service-mark">C</span><div><h3>Claude</h3><p>Custom connector · web or desktop</p></div></header>
              <ol>
                <li>Open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</li>
                <li>Name it <strong>Consecrated Hammer</strong> and paste the MCP URL above.</li>
                <li>Enter OAuth client ID <code>{mcpOauthClientId}</code>. <strong>Do not enter a client secret; leave that field empty.</strong></li>
                <li>Choose <strong>Add</strong>, then <strong>Connect</strong> and complete the Authelia sign-in.</li>
                <li>In chat, open <strong>Search and tools</strong> and enable the connector or only the tools you need.</li>
              </ol>
              <p className="mcp-plan-note">Remote custom connectors are available on Claude Pro, Max, Team and Enterprise. Team and Enterprise connectors must first be added by an owner.</p>
              <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" target="_blank" rel="noreferrer">Official Claude instructions <ExternalLink size={13} /></a>
            </article>
          </div>

          <section className="mcp-prompts" aria-labelledby="mcp-prompts-heading">
            <span className="ledger-eyebrow">TRY ASKING</span>
            <h2 id="mcp-prompts-heading">Suggested prompts</h2>
            <div>{mcpSuggestedPrompts.map((prompt, index) => <article key={prompt}><span>{String(index + 1).padStart(2, "0")}</span><p>{prompt}</p></article>)}</div>
          </section>

          <details className="mcp-capabilities">
            <summary>
              <span><Plug size={17} aria-hidden="true" /><strong>Tools and capabilities</strong><small>26 canonical tools</small></span>
              <ChevronDown size={17} aria-hidden="true" />
            </summary>
            <div className="mcp-capability-groups">{mcpCapabilityGroups.map((group) => <section key={group.title}>
              <header><h3>{group.title}</h3><p>{group.note}</p></header>
              <div>{group.tools.map(([name, description]) => <article key={name}><code>{name}</code><p>{description}</p></article>)}</div>
            </section>)}</div>
          </details>

          <aside className="mcp-privacy-note"><ShieldCheck size={19} aria-hidden="true" /><div><strong>Private by account</strong><p>Character imports and tracker records are scoped to the signed-in user. Most tools only read data; tools labelled “Updates tracker” change Consecrated Hammer’s local tracker state and never change anything in World of Warcraft or Blizzard.</p></div></aside>
        </div>
      </main>
    </Shell>
  );
}

const hammerLinkStatLabels = {
  ITEM_MOD_AGILITY_SHORT: "Agility",
  ITEM_MOD_ARMOR_SHORT: "Armor",
  ITEM_MOD_AVOIDANCE_RATING_SHORT: "Avoidance",
  ITEM_MOD_CRIT_RATING_SHORT: "Critical Strike",
  ITEM_MOD_HASTE_RATING_SHORT: "Haste",
  ITEM_MOD_INTELLECT_SHORT: "Intellect",
  ITEM_MOD_LIFESTEAL_RATING_SHORT: "Leech",
  ITEM_MOD_MASTERY_RATING_SHORT: "Mastery",
  ITEM_MOD_SPEED_RATING_SHORT: "Speed",
  ITEM_MOD_STAMINA_SHORT: "Stamina",
  ITEM_MOD_STRENGTH_SHORT: "Strength",
  ITEM_MOD_VERSATILITY: "Versatility",
};

function hammerLinkDate(value, withTime = true) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(parsed);
}

function hammerLinkItemName(item) {
  if (item?.name) return item.name;
  const match = String(item?.link || "").match(/\|h\[([^\]]+)]\|h/);
  return match?.[1] || `Item ${item?.itemID || "—"}`;
}

function HammerLinkGearTable({ items, bagGear = false }) {
  if (!items?.length) return <p className="hammerlink-empty-row">No items were present in this part of the export.</p>;
  return (
    <div className="hammerlink-table-wrap">
      <table className="hammerlink-table">
        <thead><tr><th>{bagGear ? "Bag location" : "Slot"}</th><th>Item</th><th>Item level</th><th>Type</th><th>Stats</th></tr></thead>
        <tbody>{items.map((item, index) => {
          const stats = Object.entries(item.stats || {});
          return <tr key={`${bagGear ? `${item.bag}-${item.slot}` : item.slot}-${item.itemID}-${index}`}>
            <td><span className="hammerlink-location">{bagGear ? `Bag ${item.bag} · Slot ${item.slot}` : String(item.slot || "—").replaceAll("_", " ")}</span></td>
            <td><a href={`https://www.wowhead.com/item=${item.itemID}`} target="_blank" rel="noreferrer">{hammerLinkItemName(item)}</a><small>#{item.itemID}</small></td>
            <td>{item.itemLevel ?? item.baseItemLevel ?? "—"}{item.itemLevel && item.baseItemLevel && item.itemLevel !== item.baseItemLevel ? <small>Base {item.baseItemLevel}</small> : null}</td>
            <td>{item.itemSubType || item.itemType || item.inventoryType?.replace("INVTYPE_", "") || "—"}{item.isBound !== undefined ? <small>{item.isBound ? "Bound" : "Not bound"}</small> : null}</td>
            <td>{stats.length ? <span className="hammerlink-stats">{stats.map(([stat, amount]) => <span key={stat}>{hammerLinkStatLabels[stat] || stat.replace(/^ITEM_MOD_/, "").replace(/_SHORT$/, "").replaceAll("_", " ")} <strong>{amount}</strong></span>)}</span> : <span className="hammerlink-muted">Contained in item link</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function hammerLinkSearchMatches(value, query) {
  return !query || JSON.stringify(value).toLowerCase().includes(query);
}

function hammerLinkCurrencyCapDetails(currency) {
  const details = [];
  if (currency.canEarnPerWeek && currency.maxWeeklyQuantity > 0) details.push(`Weekly cap progress ${currency.quantityEarnedThisWeek ?? 0} / ${currency.maxWeeklyQuantity}`);
  if (currency.useTotalEarnedForMaxQty && currency.maxQuantity > 0) details.push(`Season-cap progress ${currency.totalEarned ?? 0} / ${currency.maxQuantity}`);
  else if (currency.maxQuantity > 0) details.push(`Holding cap ${currency.maxQuantity}`);
  return details.join(" · ") || "No current cap progress exposed by the client";
}

function HammerLinkSection({ eyebrow, title, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className="hammerlink-section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <div><span>{eyebrow}</span><h3>{title}</h3></div>
      <span><small>{summary}</small><ChevronDown size={16} aria-hidden="true" /></span>
    </summary>
    <div className="hammerlink-section-body">{children}</div>
  </details>;
}

function HammerLinkImport() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [imports, setImports] = useState([]);
  const [detail, setDetail] = useState(null);
  const [exportText, setExportText] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [snapshotQuery, setSnapshotQuery] = useState("");
  const selectedCharacterId = Number(searchParams.get("characterId")) || null;
  const selectedImportId = Number(searchParams.get("importId")) || null;

  const openImport = useCallback(async (characterId, importId = null, { updateUrl = true } = {}) => {
    setBusy(true);
    setError("");
    try {
      const result = await api(importId ? `/api/hammerlink/imports/history/${importId}` : `/api/hammerlink/imports/${characterId}`);
      setDetail(result);
      setSnapshotQuery("");
      if (updateUrl) setSearchParams({ characterId: String(characterId), importId: String(result.importId) }, { replace: true });
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setBusy(false);
    }
  }, [setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    api("/api/hammerlink/imports").then(async (result) => {
      if (cancelled) return;
      const available = result.imports || [];
      setImports(available);
      const requested = (selectedImportId && available.find((item) => item.importId === selectedImportId))
        || (selectedCharacterId && available.find((item) => item.characterId === selectedCharacterId))
        || available[0];
      if (requested) await openImport(requested.characterId, requested.importId, { updateUrl: requested.importId !== selectedImportId });
      else setBusy(false);
    }).catch((loadError) => {
      if (!cancelled) { setError(loadError.message); setBusy(false); }
    });
    return () => { cancelled = true; };
  }, [openImport, selectedCharacterId, selectedImportId]);

  async function submitImport(event) {
    event.preventDefault();
    if (!exportText.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api("/api/hammerlink/imports", { method: "POST", body: JSON.stringify({ export: exportText.trim() }) });
      setDetail(saved);
      setSnapshotQuery("");
      setExportText("");
      setSearchParams({ characterId: String(saved.characterId), importId: String(saved.importId) }, { replace: true });
      const refreshed = await api("/api/hammerlink/imports");
      setImports(refreshed.imports || []);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }

  async function copyTalents() {
    const value = detail?.snapshot?.talents?.importString;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Your browser blocked clipboard access. Select the talent code and copy it manually.");
    }
  }

  const snapshot = detail?.snapshot;
  const character = snapshot?.character;
  const vaultActivities = snapshot?.vault?.activities || [];
  const currencyCaps = snapshot?.currencyCaps || [];
  const currencies = snapshot?.currencies;
  const currencyEntries = currencies?.entries || [];
  const reputations = snapshot?.reputations;
  const reputationEntries = reputations?.entries || [];
  const decorInventory = snapshot?.decorInventory;
  const decorItems = decorInventory?.items || [];
  const questLog = snapshot?.questLog;
  const questEntries = questLog?.entries || [];
  const currentSpellbook = snapshot?.currentSpellbook;
  const currentSpells = currentSpellbook?.spells || [];
  const professionRecipes = snapshot?.professionRecipes;
  const professionLines = professionRecipes?.professions || [];
  const professionRecipeCount = professionLines.reduce((count, line) => count + (line.recipes?.length || 0), 0);
  const normalisedQuery = snapshotQuery.trim().toLowerCase();
  const filteredEquipment = useMemo(() => (snapshot?.equipment || []).filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [snapshot, normalisedQuery]);
  const filteredBagEquipment = useMemo(() => (snapshot?.bagEquipment || []).filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [snapshot, normalisedQuery]);
  const filteredCurrencyCaps = useMemo(() => currencyCaps.filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [currencyCaps, normalisedQuery]);
  const filteredCurrencies = useMemo(() => currencyEntries.filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [currencyEntries, normalisedQuery]);
  const filteredReputations = useMemo(() => reputationEntries.filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [reputationEntries, normalisedQuery]);
  const filteredDecorItems = useMemo(() => decorItems.filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [decorItems, normalisedQuery]);
  const filteredQuestEntries = useMemo(() => questEntries.filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [questEntries, normalisedQuery]);
  const filteredCurrentSpells = useMemo(() => currentSpells.filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [currentSpells, normalisedQuery]);
  const filteredProfessionLines = useMemo(() => professionLines.map((line) => {
    const { recipes, ...lineDetails } = line;
    return { ...line, recipes: (recipes || []).filter((recipe) => hammerLinkSearchMatches({ ...lineDetails, recipe }, normalisedQuery)) };
  }).filter((line) => line.recipes.length), [professionLines, normalisedQuery]);
  const filteredVaultActivities = useMemo(() => vaultActivities.filter((item) => hammerLinkSearchMatches(item, normalisedQuery)), [vaultActivities, normalisedQuery]);
  const talentMatches = !normalisedQuery || hammerLinkSearchMatches(snapshot?.talents || {}, normalisedQuery);
  const countSummary = (filtered, total, noun) => normalisedQuery ? `${filtered} of ${total} ${noun}` : `${total} ${noun}`;
  return (
    <Shell>
      <main className="hammerlink-page">
        <section className="hammerlink-masthead">
          <div><span className="ledger-eyebrow">LIVE ADDON SNAPSHOT</span><h1>HammerLink import</h1><p>Bring this character’s selected in-game gear, bags, spellbook, talents, Vault state, currencies, reputations, Housing decor and cached profession observations into your private account.</p></div>
          <a className="hammerlink-project-link" href="https://www.curseforge.com/wow/addons/hammerlink" target="_blank" rel="noreferrer"><span><strong>Get HammerLink</strong><small>CurseForge project</small></span><ExternalLink size={16} aria-hidden="true" /></a>
        </section>

        <div className="hammerlink-layout">
          <aside className="hammerlink-sidebar">
            <form className="hammerlink-import-panel" onSubmit={submitImport}>
              <span className="hammerlink-panel-kicker"><Upload size={14} aria-hidden="true" /> NEW IMPORT</span>
              <h2>Paste an HL1 export</h2>
              <p>In game, click HammerLink or type <code>/hl export</code>, then paste the complete code below.</p>
              <label><span>HammerLink code</span><textarea value={exportText} onChange={(event) => setExportText(event.target.value)} placeholder="HL1:…" spellCheck="false" /></label>
              <button type="submit" disabled={saving || !exportText.trim()}>{saving ? "Validating and saving…" : "Import snapshot"}</button>
              <small className="hammerlink-import-note">Each character keeps its 10 most recent snapshots; MCP inventory tools use the latest.</small>
            </form>

            <section className="hammerlink-import-list" aria-label="Your HammerLink imports">
              <span className="hammerlink-panel-kicker"><Database size={14} aria-hidden="true" /> IMPORT HISTORY</span>
              {imports.length ? imports.map((item) => <button key={item.importId} type="button" className={detail?.importId === item.importId ? "is-active" : ""} onClick={() => openImport(item.characterId, item.importId)}>
                <span className="character-avatar">{item.character.avatarUrl ? <img src={item.character.avatarUrl} alt="" /> : null}</span>
                <span><strong>{item.character.name}</strong><small>{item.character.realm} · {item.character.region.toUpperCase()}</small><time dateTime={item.importedAt}>Imported {hammerLinkDate(item.importedAt)}</time></span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>) : <p className="hammerlink-list-empty">No saved imports yet.</p>}
            </section>
          </aside>

          <section className="hammerlink-output" aria-live="polite">
            {error && <div className="hammerlink-error" role="alert">{error}</div>}
            {busy && <div className="hammerlink-loading"><span aria-hidden="true" /> Loading your import…</div>}
            {!busy && !detail && !error && <div className="hammerlink-welcome"><Database size={28} aria-hidden="true" /><h2>No HammerLink data imported</h2><p>Your first validated export will appear here and become available to your MCP connection.</p></div>}
            {!busy && detail && snapshot && <>
              <header className="hammerlink-character-header">
                <div><span className="ledger-eyebrow">IN-GAME EXPORT</span><h2>{character?.name}</h2><p>{character?.realm} · Level {character?.level || "—"} {String(character?.class || "").replaceAll("_", " ")}</p></div>
                <div><span>Captured <strong>{hammerLinkDate(detail.capturedAt)}</strong></span><span>Imported <strong>{hammerLinkDate(detail.importedAt)}</strong></span></div>
              </header>

              <div className="hammerlink-summary-grid">
                <article><span>Equipped</span><strong>{detail.equipmentCount}</strong><small>{detail.equippedItemLevel != null ? `Item level ${Math.round(detail.equippedItemLevel)}` : "Exact item links"}</small></article>
                <article><span>Bag items</span><strong>{detail.bagItemCount}</strong><small>Occupied slots scanned</small></article>
                <article><span>Great Vault</span><strong>{detail.vaultActivityCount}</strong><small>Activity rows captured</small></article>
                <article><span>Talents</span><strong>{detail.hasTalentImport ? "Yes" : "—"}</strong><small>{detail.hasTalentImport ? "Active loadout captured" : "Not available"}</small></article>
                <article><span>Currency caps</span><strong>{detail.currencyCapCount ?? currencyCaps.length}</strong><small>Crests and other limits</small></article>
                <article><span>Currencies</span><strong>{detail.currencyCount ?? currencyEntries.length}</strong><small>Current wallet entries</small></article>
                <article><span>Reputations</span><strong>{detail.reputationCount ?? reputationEntries.length}</strong><small>Visible faction standings</small></article>
                <article><span>Housing decor</span><strong>{detail.decorItemCount ?? decorItems.length}</strong><small>Owned catalog entries</small></article>
                <article><span>Quest log</span><strong>{detail.questLogCount ?? questEntries.length}</strong><small>Current active quests</small></article>
                <article><span>Current spells</span><strong>{detail.currentSpellCount ?? currentSpells.length}</strong><small>Client-exposed spellbook</small></article>
                <article><span>Profession entries</span><strong>{detail.professionRecipeCount ?? professionRecipeCount}</strong><small>{detail.professionSkillLineCount ?? professionLines.length} cached skill lines</small></article>
              </div>

              <label className="hammerlink-snapshot-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Search this snapshot</span><input value={snapshotQuery} onChange={(event) => setSnapshotQuery(event.target.value)} placeholder="Search gear, bags, spells, currencies, reputations, decor, professions, quests, Vault or talents" />{snapshotQuery ? <button type="button" onClick={() => setSnapshotQuery("")} aria-label="Clear snapshot search"><X size={15} /></button> : null}</label>

              <HammerLinkSection eyebrow="CHARACTER GEAR" title="Currently equipped" summary={countSummary(filteredEquipment.length, snapshot.equipment?.length || 0, "items")}><HammerLinkGearTable items={filteredEquipment} /></HammerLinkSection>
              <HammerLinkSection eyebrow="BAG SCAN" title="All items in bags" summary={countSummary(filteredBagEquipment.length, snapshot.bagEquipment?.length || 0, "items")} defaultOpen={false}><HammerLinkGearTable items={filteredBagEquipment} bagGear /></HammerLinkSection>

              <HammerLinkSection eyebrow="CURRENCY CAPS" title="Crests and capped currencies" summary={countSummary(filteredCurrencyCaps.length, currencyCaps.length, "records")}>
                {filteredCurrencyCaps.length ? <div className="hammerlink-currency-list">{filteredCurrencyCaps.map((currency) => <div key={currency.currencyID}><strong>{currency.name}</strong><span>{currency.quantity ?? "—"} current</span><small>{hammerLinkCurrencyCapDetails(currency)}</small></div>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No currency records match this search." : snapshot.exportOptions?.currencyCaps === false ? "Currency caps were excluded in this export." : "No capped currency records were available from the client."}</p>}
              </HammerLinkSection>

              <HammerLinkSection eyebrow="CURRENT CURRENCIES" title="Current wallet entries" summary={`${countSummary(filteredCurrencies.length, currencyEntries.length, "currencies")}${currencies?.truncated ? " · export limit reached" : ""}`} defaultOpen={false}>
                {filteredCurrencies.length ? <div className="hammerlink-currency-list">{filteredCurrencies.map((currency) => <div key={currency.currencyID}><strong>{currency.name}</strong><span>{currency.quantity ?? "—"} current</span><small>Currency #{currency.currencyID}{currency.isAccountWide ? " · account-wide" : ""}{currency.isAccountTransferable ? " · transferable" : ""}</small></div>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No current currencies match this search." : snapshot.exportOptions?.currencies === false ? "Current currencies were excluded in this export." : currencies?.reason || "No current currency entries were available from the client."}</p>}
                <p className="hammerlink-scope-note">A point-in-time list from Retail’s visible currency pane. It is not transaction history or a complete account-wide balance.</p>
              </HammerLinkSection>

              <HammerLinkSection eyebrow="CURRENT REPUTATIONS" title="Visible faction standings" summary={`${countSummary(filteredReputations.length, reputationEntries.length, "factions")}${reputations?.truncated ? " · export limit reached" : ""}`} defaultOpen={false}>
                {filteredReputations.length ? <div className="hammerlink-currency-list">{filteredReputations.map((reputation) => <div key={reputation.factionID}><strong>{reputation.name}</strong><span>{reputation.currentStanding != null && reputation.currentReactionThreshold != null && reputation.nextReactionThreshold != null ? `${reputation.currentStanding - reputation.currentReactionThreshold} / ${reputation.nextReactionThreshold - reputation.currentReactionThreshold}` : reputation.reaction != null ? `Standing ${reputation.reaction}` : "Standing unavailable"}</span><small>Faction #{reputation.factionID}{reputation.isMajorFaction ? " · major faction" : ""}{reputation.isWatched ? " · watched" : ""}</small></div>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No reputation entries match this search." : snapshot.exportOptions?.reputations === false ? "Reputations were excluded in this export." : reputations?.reason || "No reputation entries were available from the client."}</p>}
                <p className="hammerlink-scope-note">A point-in-time list of visible Retail faction standings. Missing factions and unavailable standing fields remain unknown.</p>
              </HammerLinkSection>

              <HammerLinkSection eyebrow="CURRENT SPELLBOOK" title="Client-exposed spells and abilities" summary={`${countSummary(filteredCurrentSpells.length, currentSpells.length, "spells")}${currentSpellbook?.truncated ? " · export limit reached" : ""}`} defaultOpen={false}>
                {filteredCurrentSpells.length ? <div className="hammerlink-spell-list">{filteredCurrentSpells.map((spell) => <div key={spell.spellID}><strong>{spell.name}</strong><span>{spell.skillLine || "Unlabelled skill line"}</span><small>Spell #{spell.spellID}{spell.isPassive ? " · passive" : ""}{spell.isOffSpec ? " · marked off-spec" : ""}{spell.source === "flyout" ? " · flyout" : ""}</small></div>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No current spells match this search." : snapshot.exportOptions?.currentSpellbook === false ? "The current spellbook was excluded in this export." : currentSpellbook?.reason || "No current spellbook entries were available from the client."}</p>}
                <p className="hammerlink-scope-note">Entries currently exposed in this character’s spellbook. The client can include marked off-spec abilities; hidden and inactive-specialisation coverage may be incomplete.</p>
              </HammerLinkSection>

              <HammerLinkSection eyebrow="CACHED PROFESSIONS" title="Learned recipes and techniques" summary={`${normalisedQuery ? `${filteredProfessionLines.reduce((count, line) => count + line.recipes.length, 0)} of ${professionRecipeCount}` : professionRecipeCount} entries · ${professionLines.length} skill lines${professionRecipes?.truncated ? " · export limit reached" : ""}`}>
                {filteredProfessionLines.length ? <div className="hammerlink-recipe-list">{filteredProfessionLines.map((line) => <article key={line.skillLineID}><header><div><strong>{line.name}</strong><small>{line.skillLevel != null ? `${line.skillLevel}${line.maxSkillLevel != null ? ` / ${line.maxSkillLevel}` : ""}` : "Skill level unavailable"}{line.source === "filtered" ? " · client filtered list" : ""}</small></div><span>{line.recipes.length} observed</span></header><ul>{line.recipes.map((recipe) => <li key={recipe.recipeID}><span>{recipe.name}</span><small>Entry #{recipe.recipeID}</small></li>)}</ul></article>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No learned profession entries match this search." : snapshot.exportOptions?.professionRecipes === false ? "Profession entries were excluded in this export." : professionRecipes?.reason || "No profession entries have been cached yet. Open each profession window once in game, then export again; unopened professions are unknown."}</p>}
                <p className="hammerlink-scope-note">Cached positive observations from Retail’s profession list, including recipes, gathering techniques and bonuses. Missing entries remain unknown; reopen a profession after learning something new.</p>
              </HammerLinkSection>

              <HammerLinkSection eyebrow="CURRENT QUEST LOG" title="Active quests and objectives" summary={`${countSummary(filteredQuestEntries.length, questEntries.length, "quests")}${questLog?.truncated ? " · export limit reached" : ""}`}>
                {filteredQuestEntries.length ? <div className="hammerlink-quest-list">{filteredQuestEntries.map((quest) => <article key={quest.questID}>
                  <header><div><strong>{quest.title}</strong><small>Quest #{quest.questID}{quest.tag?.name ? ` · ${quest.tag.name}` : ""}{quest.campaignID ? ` · Campaign ${quest.campaignID}` : ""}</small></div><span>{quest.isFailed ? "Failed" : quest.isComplete ? "Ready to turn in" : quest.isHidden ? "Hidden / background" : "In progress"}</span></header>
                  {quest.objectives?.length ? <ul>{quest.objectives.map((objective, index) => <li key={`${quest.questID}-${index}`} className={objective.finished ? "is-complete" : ""}><span>{objective.text || "Objective progress"}</span>{objective.numRequired != null ? <small>{objective.numFulfilled ?? 0} / {objective.numRequired}</small> : null}</li>)}</ul> : <p>No objective rows were exposed by the client.</p>}
                  <footer>{quest.suggestedGroup > 0 ? <span>Suggested group: {quest.suggestedGroup}</span> : null}{quest.waypoint ? <span>Map {quest.waypoint.mapID} · {Math.round(quest.waypoint.x * 100)}, {Math.round(quest.waypoint.y * 100)}</span> : null}{quest.timer ? <span>{Math.max(0, Math.round((quest.timer.totalSeconds - quest.timer.elapsedSeconds) / 60))} min remaining</span> : null}</footer>
                </article>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No quests match this search." : snapshot.exportOptions?.questLog === false ? "The quest log was excluded in this export." : questLog?.reason || "No current quest-log entries were available from the client."}</p>}
              </HammerLinkSection>

              <HammerLinkSection eyebrow="HOUSING CATALOG" title="Owned decor inventory" summary={`${countSummary(filteredDecorItems.length, decorItems.length, "entries")}${decorInventory?.totalOwnedCount != null ? ` · ${decorInventory.totalOwnedCount} total owned` : ""}${decorInventory?.truncated ? " · export limit reached" : ""}`} defaultOpen={false}>
                {filteredDecorItems.length ? <div className="hammerlink-decor-list">{filteredDecorItems.map((item) => <div key={item.decorID}><strong>{item.name}</strong><span>Stored {item.storedCount ?? 0} · Placed {item.placedCount ?? 0}{item.redeemableCount ? ` · Redeemable ${item.redeemableCount}` : ""}</span><small>Decor #{item.decorID}{item.itemID ? ` · item #${item.itemID}` : ""}{item.uniqueTrophy ? " · unique trophy" : ""}</small></div>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No decor entries match this search." : snapshot.exportOptions?.decorInventory === false ? "Housing decor was excluded in this export." : decorInventory?.reason || "No Housing Catalog decor inventory was available from the client."}</p>}
              </HammerLinkSection>

              <div className="hammerlink-lower-grid">
                <HammerLinkSection eyebrow="GREAT VAULT" title="Captured progress" summary={countSummary(filteredVaultActivities.length, vaultActivities.length, "activities")}>
                  {filteredVaultActivities.length ? <div className="hammerlink-vault-list">{filteredVaultActivities.map((activity, index) => <div key={`${activity.type}-${activity.index}-${index}`}><strong>{activity.activityTypeName || `Activity type ${activity.type}`} · Slot {activity.index}</strong><span>Progress {activity.displayProgress ?? activity.progress ?? 0} / {activity.threshold ?? 0}</span><span>{activity.level ? `Level ${activity.level}` : "Level unavailable"}</span><small>{activity.isComplete ? "Complete" : "In progress"}{activity.activityTierID ? ` · Tier ${activity.activityTierID}` : ""}</small></div>)}</div> : <p className="hammerlink-empty-row">{normalisedQuery ? "No Great Vault rows match this search." : "No Great Vault activity rows were present."}</p>}
                </HammerLinkSection>
                <HammerLinkSection eyebrow="ACTIVE LOADOUT" title="Talent import" summary={snapshot.talents?.importString ? (talentMatches ? "Available" : "No match") : "Unavailable"}>
                  {snapshot.talents?.importString && talentMatches ? <><button className="hammerlink-copy" type="button" onClick={copyTalents}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button><code className="hammerlink-talent-code">{snapshot.talents.importString}</code></> : <p className="hammerlink-empty-row">{normalisedQuery ? "The active talent import does not match this search." : "No active talent import was exposed by the client."}</p>}
                </HammerLinkSection>
              </div>
            </>}
          </section>
        </div>
      </main>
    </Shell>
  );
}

function TrackInfoTooltip({ name, sourceInfo }) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "right-start",
    strategy: "fixed",
    middleware: [offset(8), flip({ fallbackPlacements: ["left-start", "top-start", "bottom-start"] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false, delay: { open: 120, close: 80 }, handleClose: safePolygon({ buffer: 1 }) });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  return (
    <>
      <button ref={refs.setReference} type="button" className="track-info-button" aria-label={`About ${name} gear sources`} {...getReferenceProps()}>
        <Info size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && <FloatingPortal><aside ref={refs.setFloating} className="track-source-tooltip" style={floatingStyles} {...getFloatingProps()}>
        <strong>{name} gear</strong>
        <p>{sourceInfo.summary}</p>
        <ul>{sourceInfo.sources.map((source) => <li key={source}>{source}</li>)}</ul>
      </aside></FloatingPortal>}
    </>
  );
}

function Tracks() {
  const [ilvl, setIlvl] = useState(289);
  const [characters, setCharacters] = useState([]);
  const [selectedCharacter, setSelectedCharacter] = useState(null);
  const [message, setMessage] = useState("");
  const [loadingCharacter, setLoadingCharacter] = useState(false);
  const summaries = {
    Adventurer: "Never beats yours",
    Veteran: `Beats at ${levelsIndex(tracks, "Veteran", ilvl)}/6`,
    Champion: `Beats at ${levelsIndex(tracks, "Champion", ilvl)}/6`,
    Hero: "Beats on drop, 0 crests",
    Myth: "Beats on drop, 0 crests",
  };
  const loadCharacters = useCallback(async (preferredId) => {
    const data = await api("/api/tracker/characters");
    setCharacters(data.characters || []);
    const selected = (data.characters || []).find((character) =>
      preferredId && character.id === preferredId,
    ) || (data.characters || [])[0] || null;
    if (selected) setSelectedCharacter(selected);
    return selected;
  }, []);
  const selectCharacter = useCallback((character) => {
    setSelectedCharacter(character);
    api("/api/tracker/characters/select", { method: "POST", body: JSON.stringify({ characterId: character.id }) })
      .catch((error) => setMessage(error.message));
  }, []);
  useEffect(() => {
    loadCharacters().catch((error) => setMessage(error.message));
  }, [loadCharacters]);
  useEffect(() => {
    if (!selectedCharacter) return undefined;
    let cancelled = false;
    const realm = selectedCharacter.realm_slug || selectedCharacter.realm;
    setLoadingCharacter(true);
    setMessage(`Loading ${selectedCharacter.name}’s equipped item level…`);
    api(`/api/tracks/character?${new URLSearchParams({ region: selectedCharacter.region, realm, name: selectedCharacter.name })}`)
      .then((data) => {
        if (cancelled) return;
        const baseline = data.equippedItemLevel ?? data.averageItemLevel;
        if (Number.isFinite(baseline)) {
          setIlvl(Math.max(250, Math.min(344, Math.round(baseline))));
          setMessage(`${selectedCharacter.name} is equipped at item level ${Math.round(baseline)}.`);
        } else setMessage(`Blizzard did not return an item level for ${selectedCharacter.name}.`);
      })
      .catch((error) => { if (!cancelled) setMessage(error.message); })
      .finally(() => { if (!cancelled) setLoadingCharacter(false); });
    return () => { cancelled = true; };
  }, [selectedCharacter]);

  return (
    <Shell right={<CharacterChooser selectedCharacter={selectedCharacter} characters={characters} onSelect={selectCharacter} onMessage={setMessage} reloadCharacters={loadCharacters} />}>
      <main className="mx-auto w-[min(100%-2rem,72rem)] py-6">
        <h1 className="font-serif text-3xl text-gold">Upgrade tracks</h1>
        <section className="mt-3 rounded border border-line bg-panel p-4">
          <label className="flex items-center gap-3 text-xs uppercase tracking-[.16em] text-muted">
            Compare ilvl{" "}
            <output className="text-2xl tracking-normal text-gold">
              {ilvl}
            </output>
            {loadingCharacter && <span className="normal-case tracking-normal text-muted">Loading character…</span>}
            <input
              className="flex-1 accent-amber-300"
              type="range"
              min="250"
              max="344"
              value={ilvl}
              onChange={(event) => setIlvl(Number(event.target.value))}
            />
          </label>
          <span className="sr-only" role="status">{message}</span>
          <div className="mt-5 overflow-auto">
            <div className="grid min-w-[650px] grid-cols-[8.5rem_repeat(6,minmax(0,1fr))] gap-1 text-center text-xs">
              <div />
              {[1, 2, 3, 4, 5, 6].map((rank) => (
                <div className="text-muted" key={rank}>
                  {rank}/6
                </div>
              ))}
              {tracks.map(([name, levels]) => (
                <Fragment key={name}>
                  <div className="self-center text-left">
                    <span className="inline-flex items-center gap-1">
                      <span className="font-serif text-base text-gold">{name}</span>
                      <TrackInfoTooltip name={name} sourceInfo={trackSources[name]} />
                    </span>
                    <small className="block text-muted">
                      {summaries[name]}
                    </small>
                  </div>
                  {levels.map((level) => {
                    const up = level > ilvl;
                    const equal = level === ilvl;
                    const tone = up
                      ? "border-sky-500/70 bg-sky-950/60 text-sky-200"
                      : equal
                        ? "border-violet-500/70 bg-violet-950/50 text-violet-200"
                        : "border-orange-500/70 bg-orange-950/50 text-orange-200";
                    const symbol = up ? "▲" : equal ? "▬" : "▼";
                    return (
                      <div
                        className={`flex min-h-14 items-center justify-center rounded border px-2 py-4 text-sm ${tone}`}
                        key={`${name}-${level}`}
                      >
                        <span className="mr-2 text-xs" aria-hidden="true">
                          {symbol}
                        </span>
                        <span>{level}</span>
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            <span className="text-sky-200">▲ Upgrade</span> &nbsp;{" "}
            <span className="text-violet-200">▬ Sidegrade</span> &nbsp;{" "}
            <span className="text-orange-200">▼ Downgrade</span> &nbsp; · &nbsp;
            20 Mistcrests per rank · 100 weekly cap
          </p>
        </section>
      </main>
    </Shell>
  );
}

function levelsIndex(allTracks, name, ilvl) {
  const levels = allTracks.find(([track]) => track === name)?.[1] || [];
  const index = levels.findIndex((level) => level > ilvl);
  return index < 0 ? "—" : index + 1;
}

function CharacterAvatar({ character, className = "" }) {
  return <span className={`character-avatar ${className}`.trim()} aria-hidden="true">{character?.avatar_url && <img src={character.avatar_url} alt="" />}</span>;
}

function FactionBadge({ faction, compact = false }) {
  const normalized = String(faction || "").toUpperCase();
  if (!['ALLIANCE', 'HORDE'].includes(normalized)) return null;
  const label = normalized === 'ALLIANCE' ? 'Alliance' : 'Horde';
  const logo = normalized === 'ALLIANCE' ? '/factions/alliance.png' : '/factions/horde.png';
  return <span className={`faction-badge is-${normalized.toLowerCase()} ${compact ? 'is-compact' : ''}`.trim()} title={`${label} only · Blizzard requirement`} aria-label={`${label} only · Blizzard requirement`}><img className="faction-badge-logo" src={logo} alt="" aria-hidden="true" /><span aria-hidden="true">{compact ? label[0] : `${label} only`}</span></span>;
}

function CharacterChooser({
  initialCharacter,
  selectedCharacter,
  onSelect,
  onMessage,
  reloadCharacters,
  characters = [],
  mode = "primary",
  excludeCharacterId = null,
  onForget,
}) {
  const comparisonMode = mode === "comparison";
  const availableCharacters = characters.filter((character) => character.id !== excludeCharacterId);
  const saved = initialCharacter || selectedCharacter;
  const [region, setRegion] = useState(saved?.region || "us");
  const [realm, setRealm] = useState(saved?.realm || "");
  const [name, setName] = useState(saved?.name || "");
  const [realms, setRealms] = useState([]);
  const [loadingRealms, setLoadingRealms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [forgettingId, setForgettingId] = useState(null);
  const [showForm, setShowForm] = useState(!selectedCharacter && !comparisonMode);
  const chooserRef = useRef(null);

  useEffect(() => {
    setShowForm(!selectedCharacter && !comparisonMode);
  }, [comparisonMode, selectedCharacter?.id]);

  useEffect(() => {
    const close = (event) => {
      if ((selectedCharacter || comparisonMode) && showForm && chooserRef.current && !chooserRef.current.contains(event.target)) setShowForm(false);
    };
    const escape = (event) => { if ((selectedCharacter || comparisonMode) && event.key === "Escape") setShowForm(false); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
    };
  }, [comparisonMode, selectedCharacter, showForm]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRealms(true);
    const load = async () => {
      let lastError;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const data = await api(`/api/realms?region=${region}`);
          if (!cancelled) setRealms(data.realms || []);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)));
        }
      }
      if (!cancelled && lastError) onMessage(lastError.message);
    };
    load().finally(() => !cancelled && setLoadingRealms(false));
    return () => {
      cancelled = true;
    };
  }, [region, onMessage]);

  async function submit(event) {
    event.preventDefault();
    if (!realm || !name.trim()) return;
    setSubmitting(true);
    onMessage("Opening character…");
    try {
      const result = await api("/api/tracker/characters", {
        method: "POST",
        body: JSON.stringify({ region, realm, name: name.trim() }),
      });
      const character = result.character;
      await reloadCharacters(character.id);
      onSelect(character);
      setShowForm(false);
      onMessage(`${character.name} is ready to track.`);
    } catch (error) {
      onMessage(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function forgetRecent(event, character) {
    event.stopPropagation();
    if (!onForget || character.id === selectedCharacter?.id) return;
    setForgettingId(character.id);
    try {
      await onForget(character);
    } finally {
      setForgettingId(null);
    }
  }

  return (
    <div className={`character-picker ${comparisonMode ? "comparison-picker" : ""}`} ref={chooserRef}>
      {selectedCharacter && (
        <button className="character-pill" type="button" onClick={() => setShowForm((value) => !value)} aria-expanded={showForm} aria-haspopup="dialog">
          <CharacterAvatar character={selectedCharacter} />
          <strong>{comparisonMode ? `Compare: ${selectedCharacter.name}` : selectedCharacter.name}</strong>
          <span>{selectedCharacter.realm} · {selectedCharacter.region.toUpperCase()}</span>
          <span className="character-caret" aria-hidden="true">▾</span>
        </button>
      )}
      {!selectedCharacter && !showForm && (
        <button className="character-pill" type="button" onClick={() => setShowForm(true)} aria-haspopup="dialog">
          <CharacterAvatar />
          <strong>{comparisonMode ? "Compare" : "Open character"}</strong>
          <span className="character-caret" aria-hidden="true">▾</span>
        </button>
      )}
      {showForm && (
      <section className="character-panel" aria-label={comparisonMode ? "Comparison character chooser" : "Character chooser"}>
        <div className="character-panel-title">{comparisonMode ? "COMPARE WITH" : "RECENT CHARACTERS"}</div>
        <div className="character-recents">
          {availableCharacters.slice(0, 5).map((character) => (
            <div className={`character-recent-row ${character.id === selectedCharacter?.id ? "is-current" : ""}`} key={character.id}>
              <button type="button" className="character-recent-select" onClick={() => { onSelect(character); setShowForm(false); }}>
                <CharacterAvatar character={character} />
                <strong>{character.name}</strong>
                <span>{character.realm} · {character.region.toUpperCase()}</span>
                <small>{character.completionPct || 0}%</small>
              </button>
              {character.id !== selectedCharacter?.id && onForget && <button type="button" className="character-recent-remove" disabled={forgettingId === character.id} onClick={(event) => forgetRecent(event, character)} aria-label={`Remove ${character.name} from recent characters`} title="Remove from recent characters"><X size={13} aria-hidden="true" /></button>}
            </div>
          ))}
          {comparisonMode && availableCharacters.length === 0 && <p className="character-recents-empty">Look up another character below.</p>}
        </div>
        <form className="character-lookup" onSubmit={submit}>
        <label>Region
          <select
            value={region}
            onChange={(event) => {
              setRegion(event.target.value);
              setRealm("");
            }}
          >
            <option value="us">US</option>
            <option value="eu">EU</option>
            <option value="kr">Korea</option>
            <option value="tw">Taiwan</option>
          </select>
        </label>
        <label>Realm
          <select
            value={realm}
            onChange={(event) => setRealm(event.target.value)}
            required disabled={loadingRealms}
          >
            <option value="">
              {loadingRealms ? "Loading realms…" : "Choose a realm"}
            </option>
            {realm && !realms.some((item) => item.slug === realm) && (
              <option value={realm}>{realm}</option>
            )}
            {realms.map((item) => (
              <option value={item.slug} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="character-name-field">Character
          <span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="name" required />
          <button disabled={submitting}>{submitting ? "LOADING…" : "OPEN"}</button></span>
        </label>
        </form>
      </section>
      )}
    </div>
  );
}

function ColumnFilter({ column }) {
  const value = column.getFilterValue() ?? "";
  const inputClass =
    "mt-2 w-full border border-line bg-void px-1.5 py-1 text-xs font-normal text-slate-100";
  if (column.id === "done")
    return (
      <MultiSelectFilter
        column={column}
        options={[
          ["yes", "Done"],
          ["no", "Not done"],
        ]}
        compact
      />
    );
  if (column.id === "state")
    return (
      <MultiSelectFilter
        column={column}
        options={Object.entries(states)}
        compact
      />
    );
  return (
    <input
      className={inputClass}
      aria-label={`Filter ${column.columnDef.header}`}
      value={value}
      onChange={(event) =>
        column.setFilterValue(event.target.value || undefined)
      }
      placeholder="Filter"
    />
  );
}

function MultiSelectFilter({ column, options, compact = false }) {
  const selected = Array.isArray(column.getFilterValue())
    ? column.getFilterValue()
    : [];
  const detailsRef = useRef(null);
  useEffect(() => {
    const closeWhenClickingAway = (event) => {
      if (detailsRef.current && !detailsRef.current.contains(event.target))
        detailsRef.current.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeWhenClickingAway, true);
    return () =>
      document.removeEventListener("pointerdown", closeWhenClickingAway, true);
  }, []);
  const toggle = (value) => {
    column.setFilterValue(
      selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value],
    );
    requestAnimationFrame(() => detailsRef.current?.removeAttribute("open"));
  };
  const summary = selected.length ? `${selected.length} selected` : "Any";
  return (
    <details
      ref={detailsRef}
      className={
        compact ? "relative mt-2 text-xs font-normal" : "relative text-sm"
      }
    >
      <summary className="cursor-pointer border border-line bg-void px-2 py-1 text-muted">
        {summary}
      </summary>
      <div className="absolute z-20 mt-1 min-w-40 space-y-1 border border-line bg-panel p-2 shadow-xl">
        {options.map(([value, label]) => (
          <label
            className="flex cursor-pointer items-center gap-2 whitespace-nowrap"
            key={value}
          >
            <input
              type="checkbox"
              checked={selected.includes(value)}
              onChange={() => toggle(value)}
            />
            {label}
          </label>
        ))}
        {selected.length > 0 && (
          <button
            type="button"
            className="pt-1 text-gold"
            onClick={() => {
              column.setFilterValue(undefined);
              detailsRef.current?.removeAttribute("open");
            }}
          >
            Clear
          </button>
        )}
      </div>
    </details>
  );
}

function V2FilterMenu({ groupKey, label, options, selected, open, onOpen, onToggle, category = false }) {
  const rootRef = useRef(null);
  const [expanded, setExpanded] = useState({});
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) onOpen(null); };
    const escape = (event) => { if (event.key === "Escape") onOpen(null); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [onOpen, open]);
  const selectionLabel = !selected.length ? label : selected.length === 1 && !category ? `${label} · ${selected[0].label}` : `${label} · ${selected.length}`;
  const selectedValues = new Set(selected.map((item) => item.value));
  const rows = [];
  if (category) {
    const groups = new Map();
    for (const option of options) {
      const [parent, ...rest] = option.value.split(" > ");
      if (!groups.has(parent)) groups.set(parent, { value: parent, label: parent, count: 0, children: [] });
      const group = groups.get(parent);
      group.count += option.count;
      if (rest.length) group.children.push({ ...option, label: rest.join(" › ") });
    }
    for (const group of groups.values()) {
      rows.push({ ...group, parent: true });
      if (expanded[group.value]) rows.push(...group.children.map((child) => ({ ...child, depth: 1 })));
    }
  } else rows.push(...options);
  return (
    <div className="v2-filter" ref={rootRef}>
      <button type="button" className={selected.length ? "is-active" : ""} aria-expanded={open} aria-haspopup="true" onClick={() => onOpen(open ? null : groupKey)}>
        {selectionLabel}<span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="v2-filter-menu" role="menu">
          {rows.map((option) => {
            const implied = option.depth && selectedValues.has(option.value.split(" > ")[0]);
            const checked = selectedValues.has(option.value) || implied;
            const childSelected = option.parent && options.some((child) => child.value.startsWith(`${option.value} > `) && selectedValues.has(child.value));
            return (
              <div
                className={`v2-filter-row ${option.depth ? "is-child" : ""} ${checked ? "is-selected" : ""}`}
                role="menuitemcheckbox"
                aria-checked={checked}
                tabIndex="0"
                key={option.value}
                onClick={() => onToggle(groupKey, option)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onToggle(groupKey, option);
                  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const items = [...event.currentTarget.parentElement.querySelectorAll('[role="menuitemcheckbox"]')];
                    const index = items.indexOf(event.currentTarget);
                    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                  }
                }}
              >
                <span className="v2-caret-slot">
                  {option.parent && option.children.length > 0 && (
                    <button type="button" aria-label={`${expanded[option.value] ? "Collapse" : "Expand"} ${option.label}`} aria-expanded={Boolean(expanded[option.value])} onClick={(event) => { event.stopPropagation(); setExpanded((value) => ({ ...value, [option.value]: !value[option.value] })); }}>{expanded[option.value] ? "▼" : "▶"}</button>
                  )}
                </span>
                <span className={`v2-checkbox ${childSelected && !checked ? "is-partial" : ""}`} aria-hidden="true">{checked ? "✓" : childSelected ? "–" : ""}</span>
                <span className="v2-filter-label">{option.label}</span>
                <span className="v2-filter-count">{option.count?.toLocaleString?.() || "—"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WowheadTooltips({ refreshKey }) {
  useEffect(() => {
    window.whTooltips = {
      colorLinks: false,
      iconizeLinks: false,
      renameLinks: false,
    };
    const refresh = () => window.WH?.Tooltips?.refreshLinks?.();
    const existing = document.getElementById("wowhead-tooltips");
    if (existing) {
      refresh();
      return undefined;
    }
    const script = document.createElement("script");
    script.id = "wowhead-tooltips";
    script.src = "https://wow.zamimg.com/js/tooltips.js";
    script.async = true;
    script.onload = refresh;
    document.head.appendChild(script);
    return undefined;
  }, []);
  useEffect(() => {
    window.WH?.Tooltips?.refreshLinks?.();
  }, [refreshKey]);
  return null;
}

function nestedRequirementProgress(item) {
  const leaves = [];
  const visit = (node) => {
    if (!node.children?.length) leaves.push(node);
    else node.children.forEach(visit);
  };
  (item.children || []).forEach(visit);
  if (!leaves.length) return null;
  return {
    current: item.completed ? leaves.length : leaves.filter((leaf) => leaf.completed).length,
    target: leaves.length,
  };
}

function RewardTooltipLink({ tree }) {
  const [open, setOpen] = useState(false);
  const nodeId = useFloatingNodeId();
  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open,
    onOpenChange: setOpen,
    placement: "right-start",
    strategy: "fixed",
    middleware: [offset(8), flip({ fallbackPlacements: ["left-start", "top-start"] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    delay: { open: 900, close: 80 },
    handleClose: safePolygon({ buffer: 1 }),
  });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  const url = tree.rewardUrl || `https://www.wowhead.com/item=${tree.rewardItemId}`;
  const name = tree.rewardItemName || tree.rewardDescription;
  const type = rewardTypes.find(([value]) => value === tree.rewardType)?.[1] || "Reward";
  return (
    <>
      <a ref={refs.setReference} className="nested-tooltip-trigger" href={url} target="_blank" rel="noreferrer" {...getReferenceProps()}>
        {tree.rewardItemIconUrl && <img src={tree.rewardItemIconUrl} alt="" width="26" height="26" />}
        <span>{name}</span>
        <svg className="nested-tooltip-sweep" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" /></svg>
      </a>
      <FloatingNode id={nodeId}>
        {open && (
          <FloatingPortal>
            <div ref={refs.setFloating} className="achievement-hover-card reward-hover-card" style={floatingStyles} {...getFloatingProps()}>
              <span className="reward-hover-heading">
                {tree.rewardItemIconUrl && <img src={tree.rewardItemIconUrl} alt="" width="52" height="52" />}
                <span><strong>{name}</strong><span>{type}</span></span>
              </span>
              {tree.rewardDescription && tree.rewardDescription !== name && <span className="achievement-tooltip-description">{tree.rewardDescription}</span>}
              <a className="reward-preview-link" href={url} target="_blank" rel="noreferrer">Open on Wowhead</a>
            </div>
          </FloatingPortal>
        )}
      </FloatingNode>
    </>
  );
}

function AchievementTooltipContent({ tree, fallbackName, fallbackDescription, fallbackTip, fallbackAchievementId, fallbackRequiredFaction, characterId }) {
  const requirements = tree?.children || [];
  const completedRequirements = requirements.filter((item) => item.completed).length;
  const achievementId = tree?.achievementId || fallbackAchievementId;
  const achievementName = tree?.name || fallbackName;
  return (
    <>
      <span className="achievement-tooltip-heading">
        {tree?.iconUrl && <img src={tree.iconUrl} alt="" width="40" height="40" />}
        <span>
          {achievementId ? (
            <a
              className="achievement-tooltip-title-link"
              href={`https://www.wowhead.com/achievement=${achievementId}`}
              target="_blank"
              rel="noreferrer"
            >
              {achievementName}
            </a>
          ) : <strong>{achievementName}</strong>}
          {tree?.points != null && <span className="achievement-tooltip-points">{tree.points} Points</span>}
          {tree?.isAccountWide && <span className="achievement-tooltip-account">Account-wide progress</span>}
          <FactionBadge faction={tree?.requiredFaction || fallbackRequiredFaction} />
        </span>
      </span>
      <span className="achievement-tooltip-description">{tree?.description || fallbackDescription || "Achievement details"}</span>
      {fallbackTip && (
        <span className="achievement-tooltip-tip"><strong>Checklist tip:</strong> {fallbackTip}</span>
      )}
      {requirements.length > 18 && (
        <span className="achievement-tooltip-progress-summary">
          {completedRequirements}/{requirements.length} requirements complete · incomplete shown first
        </span>
      )}
      {tree?.loading ? <span className="text-muted">Loading achievement details…</span> : <RequirementTree items={requirements} compact characterId={characterId} />}
      {(tree?.rewardDescription || tree?.rewardItemName) && (
        <span className="achievement-tooltip-reward">
          <strong>Reward:</strong>{" "}
          {(tree.rewardUrl || tree.rewardItemId) ? (
            <RewardTooltipLink tree={tree} />
          ) : (tree.rewardItemName || tree.rewardDescription)}
        </span>
      )}
    </>
  );
}

function NestedAchievementLink({ item, characterId }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [loadState, setLoadState] = useState("idle");
  const loadStarted = useRef(false);
  const nodeId = useFloatingNodeId();
  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open,
    onOpenChange: setOpen,
    placement: "right-start",
    strategy: "fixed",
    middleware: [offset(8), flip({ fallbackPlacements: ["left-start"] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    delay: { open: 900, close: 80 },
    handleClose: safePolygon({ buffer: 1 }),
  });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  useEffect(() => {
    if (!open || !characterId || loadStarted.current) return;
    loadStarted.current = true;
    setLoadState("loading");
    api(`/api/tracker/achievements/${item.achievementId}/requirements?characterId=${characterId}`)
      .then((data) => {
        setDetail(data);
        setLoadState("loaded");
      })
      .catch(() => setLoadState("failed"));
  }, [characterId, item.achievementId, open]);
  const fallbackTree = { name: item.name, children: item.children, loading: loadState === "loading" };
  return (
    <>
      <a
        ref={refs.setReference}
        className={`nested-tooltip-trigger ${item.completed ? "achievement-earned" : "achievement-unearned"}`}
        href={`https://www.wowhead.com/achievement=${item.achievementId}`}
        target="_blank"
        rel="noreferrer"
        {...getReferenceProps()}
      >
        {item.name}
        <svg className="nested-tooltip-sweep" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" />
        </svg>
      </a>
      <FloatingNode id={nodeId}>
        {open && (
          <FloatingPortal>
            <div ref={refs.setFloating} className="achievement-hover-card achievement-hover-card-nested" style={floatingStyles} {...getFloatingProps()}>
              <AchievementTooltipContent
                tree={detail || fallbackTree}
                fallbackName={item.name}
                fallbackAchievementId={item.achievementId}
                characterId={characterId}
              />
              {loadState === "failed" && <span className="text-muted">Further details are temporarily unavailable.</span>}
            </div>
          </FloatingPortal>
        )}
      </FloatingNode>
    </>
  );
}

function RequirementTree({ items, compact = false, characterId = null }) {
  if (!items?.length) return null;
  const displayLimit = 18;
  const displayedItems = compact && items.length > displayLimit
    ? [...items].sort((left, right) => Number(left.completed) - Number(right.completed)).slice(0, displayLimit)
    : items;
  const omitted = items.length - displayedItems.length;
  return (
    <ul className={compact ? "achievement-requirements achievement-requirements-compact" : "achievement-requirements"}>
      {displayedItems.map((item) => {
        const progress = compact && item.children?.length ? nestedRequirementProgress(item) : null;
        return (
          <li key={`${item.criterionId}-${item.achievementId || "criterion"}`}>
            <span className={`achievement-requirement-marker ${item.completed ? "achievement-earned" : "achievement-unearned"}`} aria-hidden="true">{item.completed ? "✓" : "○"}</span>
            <span className="sr-only">{item.completed ? "Achieved: " : "Not achieved: "}</span>
            {item.achievementId ? (
              compact ? (
                <NestedAchievementLink item={item} characterId={characterId} />
              ) : (
                <a className={item.completed ? "achievement-earned" : "achievement-unearned"} href={`https://www.wowhead.com/achievement=${item.achievementId}`} target="_blank" rel="noreferrer">{item.name}</a>
              )
            ) : <span className={item.completed ? "achievement-earned" : "achievement-unearned"}>{item.name}</span>}
            {item.progressTarget > 1 && <span className="achievement-requirement-state">{item.progressCurrent || 0}/{item.progressTarget}</span>}
            {progress && <span className="achievement-requirement-state">{progress.current}/{progress.target}</span>}
            {!compact && <RequirementTree items={item.children} characterId={characterId} />}
          </li>
        );
      })}
      {omitted > 0 && <li className="achievement-requirements-more">+{omitted} more — expand the table row to see all</li>}
    </ul>
  );
}

function AchievementName({ ...props }) {
  return <FloatingTree><AchievementNameFloating {...props} /></FloatingTree>;
}

function AchievementNameFloating({ row, tree, onLoadTree, onToggle, characterId }) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const nodeId = useFloatingNodeId();
  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open: tooltipOpen,
    onOpenChange: setTooltipOpen,
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(4), flip({ fallbackPlacements: ["top-start"] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false, handleClose: safePolygon() });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  const isMeta = Boolean(row.hasDependencies || tree?.children?.length);
  const requirements = tree?.children || [];
  const metaTotal = tree?.children?.length || row.metaProgressTarget;
  const metaCompleted = tree?.children?.length
    ? tree.children.filter((item) => item.completed).length
    : row.metaProgressCurrent;
  return (
    <div
      ref={refs.setReference}
      className="achievement-name group relative block min-w-0 whitespace-normal"
      {...getReferenceProps({ onMouseEnter: () => onLoadTree(row.achievementId) })}
    >
      <span className="flex min-w-0 items-center gap-1">
        <a
          className="min-w-0 truncate font-medium"
          target="_blank"
          rel="noreferrer"
          href={`https://www.wowhead.com/achievement=${row.achievementId}`}
          onMouseEnter={() => onLoadTree(row.achievementId)}
          onFocus={() => onLoadTree(row.achievementId)}
        >
          {row.name}
        </a>
        <FactionBadge faction={row.requiredFaction} compact />
        <span className="achievement-expander-slot">
          {isMeta && (
            <button
              type="button"
              className="achievement-expander"
              onClick={() => onToggle(row.achievementId)}
              aria-label={`${tree?.expanded ? "Collapse" : "Expand"} requirements for ${row.name}`}
              aria-expanded={Boolean(tree?.expanded)}
            >
              {metaTotal > 0 && <span className="achievement-meta-progress">{metaCompleted || 0}/{metaTotal}</span>}
              {tree?.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
          )}
        </span>
      </span>
      {tree?.expanded && <div className="achievement-inline-tree"><RequirementTree items={requirements} characterId={characterId} /></div>}
      <FloatingNode id={nodeId}>
        {tooltipOpen && (
          <FloatingPortal>
            <div ref={refs.setFloating} className="achievement-hover-card" style={floatingStyles} {...getFloatingProps()}>
              <AchievementTooltipContent tree={tree} fallbackName={row.name} fallbackDescription={row.description} fallbackTip={row.importedTip} fallbackAchievementId={row.achievementId} fallbackRequiredFaction={row.requiredFaction} characterId={characterId} />
            </div>
          </FloatingPortal>
        )}
      </FloatingNode>
    </div>
  );
}

/* eslint-disable no-unused-vars -- retained temporarily for visual regression comparison. */
function TrackerLegacy() {
  const [characters, setCharacters] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [characterId, setCharacterId] = useState(null);
  const [rows, setRows] = useState([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState([]);
  const [sorting, setSorting] = useState([{ id: "priority", desc: true }]);
  const [priorityRange, setPriorityRange] = useState([-100, 100]);
  const [priorityLabels, setPriorityLabels] = useState([]);
  const [message, setMessage] = useState("Choose a character to start.");
  const [working, setWorking] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastDataAt, setLastDataAt] = useState(null);
  const [sortMessage, setSortMessage] = useState("");
  const [isSorting, startSorting] = useTransition();
  const gridRef = useRef(null);
  const loadMoreRef = useRef(null);
  const deepLinkedCharacter = useMemo(() => {
    const region = searchParams.get("region");
    const realm = searchParams.get("realm");
    const name = searchParams.get("name");
    return region && realm && name ? { region, realm, name } : null;
  }, [searchParams]);
  const selectCharacter = (character) => {
    setCharacterId(character.id);
    const realm = character.realm_slug || character.realm;
    api("/api/tracker/characters/select", { method: "POST", body: JSON.stringify({ characterId: character.id }) })
      .catch((error) => setMessage(error.message));
    setSearchParams({ region: character.region, realm, name: character.name });
  };
  const loadCharacters = async (preferredId) => {
    const data = await api("/api/tracker/characters");
    setCharacters(data.characters);
    const wanted = deepLinkedCharacter;
    const selected = data.characters.find(
      (item) =>
        (preferredId && item.id === preferredId) ||
        (wanted &&
          item.region === wanted.region &&
          item.name.toLowerCase() === wanted.name.toLowerCase() &&
          (item.realm_slug || item.realm) === wanted.realm),
    );
    setCharacterId(selected?.id || data.characters[0]?.id || null);
  };
  const load = async () => {
    if (!characterId) return;
    setWorking("Loading achievement data…");
    try {
      const cacheKey = `wow-tracker-rows-v1-${characterId}`;
      const cached = JSON.parse(
        window.sessionStorage.getItem(cacheKey) || "null",
      );
      if (
        cached?.savedAt &&
        Date.now() - cached.savedAt < trackerCacheTtlMs &&
        Array.isArray(cached.rows)
      ) {
        setRows(cached.rows);
        setLastDataAt(cached.savedAt);
        setMessage(
          `${cached.rows.length.toLocaleString()} rows loaded from cache`,
        );
        return;
      }
      const data = await api(
        `/api/tracker/achievements?characterId=${characterId}&limit=10000`,
      );
      const savedAt = Date.now();
      setRows(data.achievements);
      setLastDataAt(savedAt);
      window.sessionStorage.setItem(
        cacheKey,
        JSON.stringify({ savedAt, rows: data.achievements }),
      );
      setMessage(`${data.achievements.length.toLocaleString()} rows loaded`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking("");
    }
  };
  useEffect(() => {
    loadCharacters().catch((error) => setMessage(error.message));
  }, [deepLinkedCharacter]);
  useEffect(() => {
    setLastDataAt(null);
    load();
  }, [characterId]);
  useEffect(() => { api('/api/tracker/priority-labels').then((data) => setPriorityLabels(data.labels || [])).catch(() => setPriorityLabels([])); }, []);
  useEffect(() => {
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [characterId]);
  const mutate = async (path, body) => {
    setWorking("Saving changes…");
    try {
      await api(path, {
        method: "POST",
        body: JSON.stringify({ ...body, characterId }),
      });
      window.sessionStorage.removeItem(`wow-tracker-rows-v1-${characterId}`);
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking("");
    }
  };
  const refresh = async () => {
    if (!characterId) return;
    setMessage("Checking Blizzard…");
    await mutate("/api/tracker/refresh", {});
  };
  const data = useMemo(
    () =>
      rows.filter(
        (row) =>
          Number(row.priority) >= priorityRange[0] &&
          Number(row.priority) <= priorityRange[1],
      ),
    [rows, priorityRange],
  );
  const columns = useMemo(
    () => [
      {
        id: "done",
        header: "Done",
        accessorFn: (row) => (row.state === "earned" ? "yes" : "no"),
        filterFn: "includesSome",
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.original.state === "earned"}
            onChange={(event) =>
              mutate("/api/tracker/state", {
                achievementId: row.original.achievementId,
                state: event.target.checked ? "earned" : "unearned",
              })
            }
          />
        ),
      },
      {
        accessorKey: "earnedAt",
        header: "Earned",
        size: 116,
        minSize: 90,
        cell: ({ getValue }) => <time dateTime={getValue() || undefined} title={getValue() || ""}>{formatEarnedAt(getValue())}</time>,
      },
      {
        accessorKey: "priority",
        header: "Priority",
        cell: ({ row, getValue }) => (
          <input
            className="w-16 border border-line bg-void p-1"
            type="number"
            min="-100"
            max="100"
            defaultValue={getValue()}
            onBlur={(event) =>
              mutate("/api/tracker/priority", {
                achievementId: row.original.achievementId,
                priority: Number(event.target.value),
              })
            }
          />
        ),
      },
      {
        accessorKey: "name",
        header: "Achievement",
        cell: ({ row, getValue }) => (
          <a
            className="block truncate font-medium"
            target="_blank"
            rel="noreferrer"
            data-wowhead={`achievement=${row.original.achievementId}`}
            href={`https://www.wowhead.com/achievement=${row.original.achievementId}`}
          >
            {getValue()}
          </a>
        ),
      },
      {
        id: "points",
        header: "Points",
        accessorFn: (row) => row.points ?? "",
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        accessorKey: "category",
        header: "Category",
        cell: ({ getValue }) => (
          <span className="text-muted">{getValue() || "—"}</span>
        ),
      },
      {
        accessorKey: "state",
        header: "Status",
        filterFn: "includesSome",
        cell: ({ getValue }) => (
          <span className="rounded bg-slate-700 px-2 py-1">
            {states[getValue()] || getValue()}
          </span>
        ),
      },
      {
        accessorKey: "note",
        header: "Notes",
        cell: ({ row, getValue }) => (
          <input
            className="w-full border border-line bg-void p-1"
            defaultValue={getValue() || ""}
            onBlur={(event) =>
              mutate("/api/tracker/state", {
                achievementId: row.original.achievementId,
                state: row.original.state,
                note: event.target.value,
              })
            }
          />
        ),
      },
    ],
    [mutate],
  );
  const table = useReactTable({
    data,
    columns,
    state: { globalFilter, columnFilters, sorting, columnOrder: ["done", "state", "priority", "name", "points", "category", "note"] },
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: (updater) => startSorting(() => setSorting(updater)),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: "includesString",
    filterFns: {
      includesSome: (row, id, value) =>
        !Array.isArray(value) ||
        value.length === 0 ||
        value.includes(String(row.getValue(id))),
    },
    initialState: { pagination: { pageSize: 50 } },
  });
  const setQuickFilter = (id, value) =>
    table.getColumn(id)?.setFilterValue(value || undefined);
  const refreshedLabel = lastDataAt
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(lastDataAt))
    : "Not loaded yet";
  const selectedCharacter =
    characters.find((character) => character.id === characterId) || null;
  const pageIndex = table.getState().pagination.pageIndex;
  useEffect(() => {
    const root = gridRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !table.getCanNextPage() || isSorting)
      return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && table.getCanNextPage()) table.nextPage();
      },
      { root, rootMargin: "180px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [table, pageIndex, isSorting]);
  return (
    <Shell>
      <main className="mx-auto flex h-[calc(100dvh-4rem)] min-h-0 w-[calc(100%-2rem)] flex-col overflow-hidden py-3">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h1 className="font-serif text-2xl text-gold">
                Achievement ledger
              </h1>
              <p className="text-xs text-muted">
                Data refreshed: {refreshedLabel}
              </p>
            </div>
            <CharacterChooser
              initialCharacter={deepLinkedCharacter}
              selectedCharacter={selectedCharacter}
              onSelect={selectCharacter}
              onMessage={setMessage}
              reloadCharacters={loadCharacters}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              className="border border-gold px-3 py-1 text-sm text-gold disabled:opacity-50"
              disabled={!characterId}
              onClick={refresh}
            >
              Refresh Blizzard
            </button>
            <p className="text-xs text-muted" aria-live="polite">
              {message}
            </p>
          </div>
        </div>
        {working && (
          <div
            className="mt-2 flex shrink-0 items-center gap-2 rounded border border-gold/70 bg-amber-950/40 px-2 py-1 text-xs text-gold"
            role="status"
          >
            <span className="inline-block animate-spin">◌</span>
            {working}
          </div>
        )}
        {characterId ? (
          <>
            <WowheadTooltips
              refreshKey={`${table.getState().pagination.pageIndex}:${globalFilter}:${columnFilters.length}:${sorting.length}:${rows.length}`}
            />
            <section
              className="mt-2 flex shrink-0 flex-wrap items-end gap-2 rounded border border-line bg-panel p-2"
              aria-label="Tracker filters"
            >
              <label className="grid min-w-56 gap-1 text-xs text-muted">
                Search everything
                <input
                  className="border border-line bg-void p-2 text-sm text-slate-100"
                  value={globalFilter}
                  onChange={(event) => setGlobalFilter(event.target.value)}
                  placeholder="Achievement, category, notes…"
                />
              </label>
              <div className="grid gap-1 text-xs text-muted">
                Done
                <MultiSelectFilter
                  column={table.getColumn("done")}
                  options={[
                    ["yes", "Done"],
                    ["no", "Not done"],
                  ]}
                />
              </div>
              <div className="grid gap-1 text-xs text-muted">
                Status
                <MultiSelectFilter
                  column={table.getColumn("state")}
                  options={Object.entries(states)}
                />
              </div>
              <fieldset className="grid min-w-44 gap-1 text-xs text-muted">
                <legend>Priority</legend>
                <div className="flex gap-2">
                  <label>
                    Min{" "}
                    <input
                      className="w-16 border border-line bg-void p-2 text-sm text-slate-100"
                      type="number"
                      min="-100"
                      max="100"
                      value={priorityRange[0]}
                      onChange={(event) =>
                        setPriorityRange(([min, max]) => [
                          Math.min(Number(event.target.value), max),
                          max,
                        ])
                      }
                    />
                  </label>
                  <label>
                    Max{" "}
                    <input
                      className="w-16 border border-line bg-void p-2 text-sm text-slate-100"
                      type="number"
                      min="-100"
                      max="100"
                      value={priorityRange[1]}
                      onChange={(event) =>
                        setPriorityRange(([min, max]) => [
                          min,
                          Math.max(Number(event.target.value), min),
                        ])
                      }
                    />
                  </label>
                </div>
              </fieldset>
              <label className="grid min-w-44 gap-1 text-xs text-muted">
                Category
                <input
                  className="border border-line bg-void p-2 text-sm text-slate-100"
                  value={table.getColumn("category")?.getFilterValue() ?? ""}
                  onChange={(event) =>
                    setQuickFilter("category", event.target.value)
                  }
                  placeholder="Any category"
                />
              </label>
              <button
                className="border border-line px-3 py-2 text-sm text-muted"
                onClick={() => {
                  setGlobalFilter("");
                  setColumnFilters([]);
                  setPriorityRange([-100, 100]);
                }}
              >
                Clear filters
              </button>
              <span className="ml-auto text-xs text-muted" aria-live="polite">
                {isSorting ? (
                  <>
                    <span className="mr-1 inline-block animate-spin">◌</span>
                    {sortMessage || "Sorting…"}
                  </>
                ) : (
                  `${table.getFilteredRowModel().rows.length.toLocaleString()} shown`
                )}
              </span>
            </section>
            <div
              ref={gridRef}
              className="mt-2 min-h-0 flex-1 overflow-auto rounded border border-line"
            >
              <table className="min-w-[1200px] border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-slate-800 text-left">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          className="border border-line px-2 py-1 align-top"
                          key={header.id}
                        >
                          {header.isPlaceholder ? null : (
                            <>
                              <button
                                className={`flex w-full items-center justify-between gap-2 text-left ${isSorting ? "cursor-progress opacity-70" : ""}`}
                                onClick={() => {
                                  const label = `Sorting by ${header.column.columnDef.header}…`;
                                  setSortMessage(label);
                                  setWorking(label);
                                  requestAnimationFrame(() =>
                                    startSorting(() => {
                                      header.column.toggleSorting();
                                      setWorking("");
                                    }),
                                  );
                                }}
                              >
                                {flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                                <span className="text-gold">
                                  {isSorting
                                    ? "◌"
                                    : ({ asc: "↑", desc: "↓" }[
                                        header.column.getIsSorted()
                                      ] ?? "↕")}
                                </span>
                              </button>
                              {!['done', 'state'].includes(header.column.id) && <ColumnFilter column={header.column} />}
                            </>
                          )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr
                      className="border-t border-line hover:bg-slate-800/70"
                      key={row.id}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          className="border border-line px-2 py-1 align-top"
                          key={cell.id}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div
                ref={loadMoreRef}
                className="px-2 py-2 text-center text-xs text-muted"
              >
                {table.getCanNextPage()
                  ? "Scroll to load more…"
                  : "End of results"}
              </div>
            </div>
          </>
        ) : (
          <p className="mt-5 rounded border border-dashed border-line p-6 text-muted">
            Use the chooser above to open any character and realm.
          </p>
        )}
      </main>
    </Shell>
  );
}

/* eslint-enable no-unused-vars */

const PAGE_SIZE = 100;
const filterQueryKeys = ["expansion", "patch", "category", "reward", "priority", "source"];
const initialTrackerFilters = () => {
  const params = new URLSearchParams(window.location.search);
  const status = ["all", "unearned", "progress", "earned"].includes(params.get("status"))
    ? params.get("status")
    : "all";
  return {
    status,
    query: params.get("q") || "",
    compareCharacterId: /^\d+$/.test(params.get("compareCharacterId") || "") ? Number(params.get("compareCharacterId")) : null,
    neededByBoth: params.get("neededByBoth") === "1",
    excludePvp: params.get("excludePvp") === "1",
    selections: Object.fromEntries(filterQueryKeys.map((key) => [
      key,
      params.getAll(key).map((value) => ({ value, label: value })),
    ])),
  };
};
const clearTrackerCache = (characterId) =>
  Object.keys(sessionStorage)
    .filter(
      (key) =>
        key.startsWith(`wow-tracker-page-v2-${characterId}-`) ||
        key.startsWith(`wow-tracker-page-v3-${characterId}-`) ||
        key.startsWith(`wow-tracker-page-v4-${characterId}-`) ||
        key.startsWith(`wow-tracker-page-v5-${characterId}-`) ||
        key.startsWith(`wow-tracker-page-v6-${characterId}-`),
    )
    .forEach((key) => sessionStorage.removeItem(key));

function Tracker() {
  const initialFilters = useMemo(initialTrackerFilters, []);
  const [characters, setCharacters] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [characterId, setCharacterId] = useState(null);
  const [comparisonCharacterId, setComparisonCharacterId] = useState(initialFilters.compareCharacterId);
  const [neededByBoth, setNeededByBoth] = useState(initialFilters.neededByBoth && Boolean(initialFilters.compareCharacterId));
  const [excludePvp, setExcludePvp] = useState(initialFilters.excludePvp);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [globalFilter, setGlobalFilter] = useState(initialFilters.query);
  const [columnFilters, setColumnFilters] = useState([]);
  const [statusFilter, setStatusFilter] = useState(initialFilters.status);
  const [facetSelections, setFacetSelections] = useState(initialFilters.selections);
  const [facets, setFacets] = useState({ status: [], expansion: [], patch: [], category: [], reward: [], priority: [] });
  const [summary, setSummary] = useState({ achievementTotal: 0, achievementEarned: 0, pointsEarned: 0, pointsTotal: 0, completionPct: 0, recentAchievements: [] });
  const [openFilter, setOpenFilter] = useState(null);
  const [sorting, setSorting] = useState([{ id: "priority", desc: true }]);
  const [priorityRange, setPriorityRange] = useState([-100, 100]);
  const [priorityLabels, setPriorityLabels] = useState([]);
  const [editingPriorityLabels, setEditingPriorityLabels] = useState(false);
  const [requirementTrees, setRequirementTrees] = useState({});
  const [columnSizing, setColumnSizing] = useState(readColumnSizing);
  const [message, setMessage] = useState("Choose a character to start.");
  const [working, setWorking] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [savingAchievementIds, setSavingAchievementIds] = useState(() => new Set());
  const [savedViews, setSavedViews] = useState(readSavedViews);
  const [savedViewsOpen, setSavedViewsOpen] = useState(false);
  const [isSorting, startSorting] = useTransition();
  const searchRef = useRef(null);
  const gridRef = useRef(null);
  const loadMoreRef = useRef(null);
  const linked = useMemo(() => {
    const region = searchParams.get("region");
    const realm = searchParams.get("realm");
    const name = searchParams.get("name");
    return region && realm && name ? { region, realm, name } : null;
  }, [searchParams]);
  const selectedCharacter =
    characters.find((character) => character.id === characterId) || null;
  const comparisonCharacter =
    characters.find((character) => character.id === comparisonCharacterId) || null;
  useEffect(() => {
    if (!characterId) return;
    Promise.all([
      api(`/api/tracker/facets?characterId=${characterId}`),
      api(`/api/tracker/summary?characterId=${characterId}`),
    ]).then(([facetData, summaryData]) => {
      setFacets(facetData);
      setSummary(summaryData);
    }).catch((error) => setMessage(error.message));
  }, [characterId]);
  useEffect(() => {
    try {
      window.localStorage.setItem(trackerColumnSizingKey, JSON.stringify(columnSizing));
    } catch {
      /* storage is optional */
    }
  }, [columnSizing]);
  useEffect(() => {
    const focusSearch = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);
  useEffect(() => {
    const path = characterId
      ? `/api/tracker/priority-labels?characterId=${characterId}`
      : "/api/tracker/priority-labels";
    api(path).then((data) => setPriorityLabels(data.labels || [])).catch((error) => setMessage(error.message));
  }, [characterId]);
  const loadCharacters = useCallback(
    async (preferredId) => {
      const data = await api("/api/tracker/characters");
      const available = data.characters || [];
      let selected = available.find(
        (item) =>
          (preferredId && item.id === preferredId) ||
          (linked &&
            item.region === linked.region &&
            item.name.toLowerCase() === linked.name.toLowerCase() &&
            (item.realm_slug || item.realm) === linked.realm),
      );
      selected ||= available[0] || null;
      setCharacters(available);
      setCharacterId(selected?.id || null);
      setComparisonCharacterId((current) => available.some((item) => item.id === current) && current !== selected?.id ? current : null);
      return selected;
    },
    [linked],
  );
  const selectCharacter = (character) => {
    const realm = character.realm_slug || character.realm;
    setCharacterId(character.id);
    if (comparisonCharacterId === character.id) {
      setComparisonCharacterId(null);
      setNeededByBoth(false);
    }
    api("/api/tracker/characters/select", { method: "POST", body: JSON.stringify({ characterId: character.id }) })
      .catch((error) => setMessage(error.message));
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("region", character.region);
      next.set("realm", realm);
      next.set("name", character.name);
      return next;
    });
  };
  const reloadComparisonCharacters = useCallback(async (preferredId) => {
    const data = await api("/api/tracker/characters");
    const available = data.characters || [];
    setCharacters(available);
    return available.find((item) => item.id === preferredId) || null;
  }, []);
  const selectComparisonCharacter = (character) => {
    if (character.id === characterId) {
      setMessage("Choose a different character to compare.");
      return;
    }
    setComparisonCharacterId(character.id);
    setNeededByBoth(true);
    api("/api/tracker/characters/select", { method: "POST", body: JSON.stringify({ characterId: character.id }) })
      .catch((error) => setMessage(error.message));
  };
  const clearComparison = () => {
    setComparisonCharacterId(null);
    setNeededByBoth(false);
  };
  const forgetRecentCharacter = async (character) => {
    await api(`/api/tracker/characters/${character.id}`, { method: "DELETE" });
    const data = await api("/api/tracker/characters");
    setCharacters(data.characters || []);
    if (comparisonCharacterId === character.id) clearComparison();
    setMessage(`${character.name} was removed from your recent characters. Its tracker data is unchanged.`);
  };
  useEffect(() => {
    if (!comparisonCharacterId) setNeededByBoth(false);
  }, [comparisonCharacterId]);
  useEffect(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("status");
      next.delete("q");
      next.delete("compareCharacterId");
      next.delete("neededByBoth");
      next.delete("excludePvp");
      filterQueryKeys.forEach((key) => next.delete(key));
      if (statusFilter !== "all") next.set("status", statusFilter);
      if (globalFilter.trim()) next.set("q", globalFilter.trim());
      if (comparisonCharacterId) next.set("compareCharacterId", String(comparisonCharacterId));
      if (comparisonCharacterId && neededByBoth) next.set("neededByBoth", "1");
      if (excludePvp) next.set("excludePvp", "1");
      filterQueryKeys.forEach((key) => {
        (facetSelections[key] || []).forEach((item) => next.append(key, String(item.value)));
      });
      return next;
    }, { replace: true });
  }, [comparisonCharacterId, excludePvp, facetSelections, globalFilter, neededByBoth, setSearchParams, statusFilter]);
  const loadRequirementTree = useCallback(async (achievementId) => {
    if (!characterId || requirementTrees[achievementId]?.loading || requirementTrees[achievementId]?.children) return;
    setRequirementTrees((current) => ({ ...current, [achievementId]: { ...current[achievementId], loading: true } }));
    try {
      const data = await api(`/api/tracker/achievements/${achievementId}/requirements?characterId=${characterId}`);
      setRequirementTrees((current) => ({ ...current, [achievementId]: { ...data, expanded: current[achievementId]?.expanded || false, loading: false } }));
    } catch (error) {
      setMessage(error.message);
      setRequirementTrees((current) => ({ ...current, [achievementId]: { ...current[achievementId], loading: false } }));
    }
  }, [characterId, requirementTrees]);
  const toggleRequirementTree = useCallback((achievementId) => {
    setRequirementTrees((current) => ({ ...current, [achievementId]: { ...current[achievementId], expanded: !current[achievementId]?.expanded } }));
    loadRequirementTree(achievementId);
  }, [loadRequirementTree]);
  const serverFilters = useMemo(
    () => ({
      ...Object.fromEntries(columnFilters.map((filter) => [filter.id, filter.value])),
      ...(statusFilter === "unearned" ? { state: ["unearned"] } : {}),
      ...(statusFilter === "progress" ? { state: ["in_progress", "completion_ready"] } : {}),
      ...(statusFilter === "earned" ? { state: ["earned"] } : {}),
      ...(facetSelections.source.length ? { completionSource: facetSelections.source.map((item) => item.value) } : {}),
      ...(facetSelections.reward.length ? { rewardType: facetSelections.reward.map((item) => item.value) } : {}),
      ...(facetSelections.expansion.length ? { addedExpansion: facetSelections.expansion.map((item) => item.value) } : {}),
      ...(facetSelections.patch.length ? { addedPatch: facetSelections.patch.map((item) => item.value) } : {}),
      ...(facetSelections.category.length ? { category: facetSelections.category.map((item) => item.value) } : {}),
      ...(facetSelections.priority.length ? { priorityValues: facetSelections.priority.map((item) => Number(item.value)) } : {}),
      ...(excludePvp ? { excludePvp: true } : {}),
    }),
    [columnFilters, excludePvp, facetSelections, statusFilter],
  );
  const query = useMemo(
    () =>
      JSON.stringify({ globalFilter, serverFilters, priorityRange, sorting, comparisonCharacterId, neededByBoth }),
    [comparisonCharacterId, globalFilter, neededByBoth, serverFilters, priorityRange, sorting],
  );
  const fetchPage = useCallback(
    async (offset, replace = false) => {
      if (!characterId) return;
    const cacheKey = `wow-tracker-page-v6-${characterId}-${query}-${offset}`;
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      setLoadingPage(true);
      try {
        let data =
          cached?.savedAt && Date.now() - cached.savedAt < trackerCacheTtlMs
            ? cached.data
            : null;
        if (!data) {
          const params = new URLSearchParams({
            characterId: String(characterId),
            limit: String(PAGE_SIZE),
            offset: String(offset),
            q: globalFilter,
            filters: JSON.stringify(serverFilters),
            priorityMin: String(priorityRange[0]),
            priorityMax: String(priorityRange[1]),
          });
          if (comparisonCharacterId) params.set("compareCharacterId", String(comparisonCharacterId));
          if (comparisonCharacterId && neededByBoth) params.set("neededByBoth", "true");
          const sort = sorting[0];
          if (sort) {
            params.set("sortBy", sort.id);
            params.set("sortDir", sort.desc ? "desc" : "asc");
          }
          data = await api(`/api/tracker/achievements?${params}`);
          sessionStorage.setItem(
            cacheKey,
            JSON.stringify({ savedAt: Date.now(), data }),
          );
        }
        setRows((current) =>
          replace ? data.achievements : [...current, ...data.achievements],
        );
        setTotal(data.total);
        setHasMore(data.hasMore);
        setMessage(`${data.total.toLocaleString()} achievements in scope`);
      } catch (error) {
        setMessage(error.message);
      } finally {
        setLoadingPage(false);
      }
    },
    [characterId, comparisonCharacterId, neededByBoth, query, globalFilter, serverFilters, priorityRange, sorting],
  );
  useEffect(() => {
    loadCharacters().catch((error) => setMessage(error.message));
  }, [loadCharacters]);
  useEffect(() => {
    if (!characterId) return undefined;
    const timer = setTimeout(
      () => {
        setHasMore(false);
        fetchPage(0, true);
      },
      globalFilter ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [characterId, query, fetchPage, globalFilter]);
  const loadMore = useCallback(() => {
    if (!loadingPage && hasMore) fetchPage(rows.length);
  }, [loadingPage, hasMore, fetchPage, rows.length]);
  useEffect(() => {
    const root = gridRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !hasMore || loadingPage) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore();
      },
      { root, rootMargin: "240px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadingPage, loadMore]);
  const mutate = async (path, body) => {
    try {
      await api(path, {
        method: "POST",
        body: JSON.stringify({ ...body, characterId }),
      });
      clearTrackerCache(characterId);
      await fetchPage(0, true);
    } catch (error) {
      setMessage(error.message);
    } finally { /* row controls save without obscuring the ledger */ }
  };
  const mutateDone = async (achievementId, state) => {
    const current = rows.find((row) => row.achievementId === achievementId);
    if (!current || savingAchievementIds.has(achievementId)) return;
    const previous = {
      state: current.state,
      source: current.source,
      earnedAt: current.earnedAt,
      markedDoneAt: current.markedDoneAt,
      blizzardConfirmedAt: current.blizzardConfirmedAt,
    };
    const markedAt = state === "earned" ? new Date().toISOString() : null;
    setSavingAchievementIds((ids) => new Set(ids).add(achievementId));
    setRows((items) => items.map((row) => row.achievementId === achievementId
      ? {
          ...row,
          state,
          source: state === "earned" ? "manual_confirmation" : "manual",
          earnedAt: markedAt,
          markedDoneAt: markedAt,
          blizzardConfirmedAt: state === "earned" ? row.blizzardConfirmedAt : null,
        }
      : row));
    try {
      const saved = await api("/api/tracker/state", {
        method: "POST",
        body: JSON.stringify({ achievementId, state, characterId }),
      });
      clearTrackerCache(characterId);
      setRows((items) => items.map((row) => row.achievementId === achievementId
        ? {
            ...row,
            state: saved.state,
            source: saved.source,
            earnedAt: saved.earnedAt,
            markedDoneAt: saved.source === "manual_confirmation" ? saved.earnedAt : null,
          }
        : row));
    } catch (error) {
      setRows((items) => items.map((row) => row.achievementId === achievementId ? { ...row, ...previous } : row));
      setMessage(error.message);
    } finally {
      setSavingAchievementIds((ids) => {
        const next = new Set(ids);
        next.delete(achievementId);
        return next;
      });
    }
  };
  const refresh = async () => {
    setIsRefreshing(true);
    setWorking("Checking Blizzard…");
    try {
      const result = await api("/api/tracker/refresh", {
        method: "POST",
        body: JSON.stringify({ characterId }),
      });
      clearTrackerCache(characterId);
      const [summaryData, facetData] = await Promise.all([
        api(`/api/tracker/summary?characterId=${characterId}`),
        api(`/api/tracker/facets?characterId=${characterId}`),
        loadCharacters(characterId),
        fetchPage(0, true),
      ]);
      setSummary(summaryData);
      setFacets(facetData);
      setMessage(`Blizzard refresh complete · ${result.recordedRecentEarned || 0} recent completion${result.recordedRecentEarned === 1 ? "" : "s"} recorded`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking("");
      setIsRefreshing(false);
    }
  };
  const savePriorityLabels = async (labels) => {
    setWorking("Saving your priority labels…");
    try {
      const data = await api("/api/tracker/priority-labels", {
        method: "POST",
        body: JSON.stringify({ labels }),
      });
      setPriorityLabels(data.labels || []);
      setEditingPriorityLabels(false);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking("");
    }
  };
  const columns = useMemo(
    () => [
      {
        id: "done",
        header: "Done",
        size: 48,
        minSize: 32,
        accessorFn: (row) => (row.state === "earned" ? "yes" : "no"),
        filterFn: "includesSome",
        cell: ({ row }) => {
          const isSaving = savingAchievementIds.has(row.original.achievementId);
          return (
            <input
              className="tracker-done-checkbox"
              type="checkbox"
              checked={row.original.state === "earned"}
              disabled={isSaving}
              aria-label={`${row.original.state === "earned" ? "Uncheck" : "Check"} ${row.original.name}`}
              title={isSaving ? "Saving…" : row.original.state === "earned" ? "Checked by you" : "Mark as done"}
              onChange={(event) => mutateDone(row.original.achievementId, event.target.checked ? "earned" : "unearned")}
            />
          );
        },
      },
      {
        accessorKey: "priority",
        header: "Priority",
        size: 160,
        minSize: 120,
        cell: ({ row, getValue }) => (
          <select
            className="tracker-cell-input w-36"
            value={priorityValueFor(getValue(), priorityLabels)}
            onChange={(event) =>
              mutate("/api/tracker/priority", {
                achievementId: row.original.achievementId,
                priority: Number(event.target.value),
              })
            }
            aria-label={`Priority for ${row.original.name}`}
          >
            {priorityOptionsFor(priorityLabels).map(({ priority, label }) => (
              <option key={priority} value={priority}>
                {label}
              </option>
            ))}
          </select>
        ),
      },
      {
        accessorKey: "name",
        header: "Achievement",
        size: 260,
        minSize: 160,
        cell: ({ row }) => <AchievementName row={row.original} tree={requirementTrees[row.original.achievementId]} onLoadTree={loadRequirementTree} onToggle={toggleRequirementTree} characterId={characterId} />,
      },
      {
        id: "points",
        header: "Points",
        size: 68,
        minSize: 58,
        accessorFn: (row) => row.points ?? "",
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        accessorKey: "category",
        header: "Category",
        size: 180,
        minSize: 120,
        cell: ({ getValue }) => <span className="block truncate">{getValue() || "—"}</span>,
      },
      {
        accessorKey: "description",
        header: "Blizzard description",
        size: 320,
        minSize: 180,
        cell: ({ getValue }) => (
          <span className="block truncate" title={getValue() || ""}>{getValue() || "—"}</span>
        ),
      },
      {
        accessorKey: "state",
        header: "Status",
        size: 96,
        minSize: 56,
        filterFn: "includesSome",
        cell: ({ row, getValue }) => {
          if (savingAchievementIds.has(row.original.achievementId)) {
            return <span className="ledger-status is-saving">Saving…</span>;
          }
          if (getValue() === "earned" && row.original.blizzardConfirmedAt) {
            return <span className="ledger-status is-confirmed" title={row.original.earnedAt ? `Blizzard confirmed · earned ${formatEarnedAt(row.original.earnedAt)}` : "Blizzard confirmed"}><span aria-hidden="true">◆</span> Blizzard confirmed</span>;
          }
          if (getValue() === "earned" && row.original.markedDoneAt) {
            return <span className="ledger-status is-manual" title="Checked by you"><span aria-hidden="true">◇</span> Checked by you</span>;
          }
          return <span className={`ledger-status is-${getValue()}`} title={states[getValue()] || getValue()}>{states[getValue()] || getValue()}</span>;
        },
      },
      ...(comparisonCharacter ? [{
        id: "comparisonState",
        header: comparisonCharacter.name,
        size: 150,
        minSize: 110,
        accessorFn: (row) => row.comparisonState,
        cell: ({ row, getValue }) => {
          const current = row.original.comparisonProgressCurrent;
          const target = row.original.comparisonProgressTarget;
          const progress = Number.isFinite(current) && Number.isFinite(target) ? ` · ${current}/${target}` : "";
          return <span className={`ledger-status is-${getValue()}`} title={`${states[getValue()] || getValue()}${progress}`}><span aria-hidden="true">{getValue() === "earned" ? "◆" : getValue() === "unknown" ? "—" : "◇"}</span> {states[getValue()] || getValue()}{progress}</span>;
        },
      }] : []),
      {
        accessorKey: "note",
        header: "Notes",
        size: 340,
        minSize: 180,
        cell: ({ row, getValue }) => (
          <input
            className="tracker-cell-input w-full"
            defaultValue={getValue() || ""}
            title={getValue() || ""}
            onBlur={(event) =>
              mutate("/api/tracker/state", {
                achievementId: row.original.achievementId,
                state: row.original.state,
                note: event.target.value,
              })
            }
          />
        ),
      },
    ],
    [characterId, comparisonCharacter, loadRequirementTree, mutate, mutateDone, priorityLabels, requirementTrees, savingAchievementIds, toggleRequirementTree],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { globalFilter, columnFilters, sorting, columnSizing, columnOrder: ["done", "state", ...(comparisonCharacter ? ["comparisonState"] : []), "priority", "name", "points", "category", "description", "note"] },
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    onSortingChange: (updater) => {
      setWorking("Sorting achievements…");
      startSorting(() => setSorting(updater));
    },
    getCoreRowModel: getCoreRowModel(),
    manualFiltering: true,
    manualSorting: true,
    columnResizeMode: "onChange",
    filterFns: {
      includesSome: (row, id, value) =>
        !Array.isArray(value) ||
        !value.length ||
        value.includes(String(row.getValue(id))),
    },
  });
  const toggleFacet = (groupKey, option) => {
    setFacetSelections((current) => {
      const selected = current[groupKey] || [];
      return {
        ...current,
        [groupKey]: selected.some((item) => item.value === option.value)
          ? selected.filter((item) => item.value !== option.value)
          : [...selected, option],
      };
    });
  };
  const rewardLabels = Object.fromEntries(rewardTypes);
  const facetGroups = [
    { key: "expansion", label: "Expansion", options: [...(facets.expansion || [])].sort((left, right) => (expansionReleaseRank.get(left.value) ?? 999) - (expansionReleaseRank.get(right.value) ?? 999) || left.value.localeCompare(right.value)).map((item) => ({ ...item, label: item.value })) },
    { key: "patch", label: "Patch", options: (facets.patch || []).sort((left, right) => right.value.localeCompare(left.value, undefined, { numeric: true })).map((item) => ({ ...item, label: item.value })) },
    { key: "category", label: "Category", category: true, options: (facets.category || []).map((item) => ({ ...item, label: item.value.replaceAll(" > ", " › ") })) },
    { key: "reward", label: "Reward", options: (facets.reward || []).map((item) => ({ ...item, label: rewardLabels[item.value] || item.value })) },
    { key: "source", label: "Recorded by", options: (facets.source || []).map((item) => ({ ...item, label: item.value === "manual_confirmation" ? "Checked by you" : "Blizzard confirmed" })) },
    { key: "priority", label: "Priority", options: (facets.priority || []).sort((left, right) => Number(right.value) - Number(left.value)).map((item) => ({ ...item, value: String(item.value), label: priorityLabelFor(Number(item.value), priorityLabels) })) },
  ];
  const activeFacets = facetGroups.flatMap((group) => (facetSelections[group.key] || []).map((item) => ({ ...item, groupKey: group.key, groupLabel: group.label })));
  const clearAll = () => {
    setGlobalFilter("");
    setColumnFilters([]);
    setStatusFilter("all");
    setFacetSelections({ expansion: [], patch: [], category: [], reward: [], priority: [], source: [] });
    setPriorityRange([-100, 100]);
    clearComparison();
    setExcludePvp(false);
  };
  const persistSavedViews = (next) => {
    setSavedViews(next);
    try {
      window.localStorage.setItem(trackerSavedViewsKey, JSON.stringify(next));
    } catch {
      setMessage("This browser could not persist the saved view.");
    }
  };
  const saveCurrentView = (name) => {
    const view = { name, state: { status: statusFilter, query: globalFilter, selections: facetSelections, excludePvp } };
    persistSavedViews([...savedViews.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), view]);
    setMessage(`Saved view “${name}” in this browser.`);
  };
  const openSavedView = (view) => {
    setStatusFilter(view.state.status || "all");
    setGlobalFilter(view.state.query || "");
    setFacetSelections({ ...initialFilters.selections, ...(view.state.selections || {}) });
    setExcludePvp(Boolean(view.state.excludePvp));
    setSavedViewsOpen(false);
    setMessage(`Opened saved view “${view.name}”.`);
  };
  const statusCounts = Object.fromEntries((facets.status || []).map((item) => [item.value, item.count]));
  const statusOptions = [
    ["all", "All", summary.achievementTotal],
    ["unearned", "Unearned", statusCounts.unearned || 0],
    ["progress", "In progress", (statusCounts.in_progress || 0) + (statusCounts.completion_ready || 0)],
    ["earned", "Earned", statusCounts.earned || 0],
  ];
  const refreshed = selectedCharacter?.last_blizzard_refresh_at
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(selectedCharacter.last_blizzard_refresh_at))
    : "Not yet refreshed from Blizzard";
  return (
    <Shell right={<CharacterChooser initialCharacter={linked} selectedCharacter={selectedCharacter} characters={characters} onSelect={selectCharacter} onForget={forgetRecentCharacter} onMessage={setMessage} reloadCharacters={loadCharacters} />}>
      <main className="tracker-v2">
        <section className="ledger-masthead">
          <div className="ledger-identity">
            <div className="ledger-identity-copy">
              <span className="ledger-eyebrow">ACHIEVEMENT LEDGER</span>
              <h1>{selectedCharacter?.name || "Choose a character"}</h1>
              {selectedCharacter && <p>{[selectedCharacter.race, selectedCharacter.character_class].filter(Boolean).join(" ") || "World of Warcraft character"} · {selectedCharacter.realm} ({selectedCharacter.region.toUpperCase()})<br />Blizzard data checked {refreshed}</p>}
              <span className="sr-only" role="status">{message}</span>
            </div>
            {selectedCharacter && <CharacterAvatar character={selectedCharacter} className="ledger-identity-avatar" />}
          </div>
          {characterId && (
            <div className="ledger-metrics">
              <div className="completion-ring" style={{ "--completion": `${summary.completionPct}%` }}><span>{summary.completionPct}%</span></div>
              <div className="ledger-metric"><span>POINTS</span><strong>{summary.pointsEarned.toLocaleString()}</strong><small>of {summary.pointsTotal.toLocaleString()}</small></div>
              <div className="ledger-metric"><span>IN SCOPE</span><strong>{summary.achievementTotal.toLocaleString()}</strong><small>{total.toLocaleString()} shown</small></div>
              {(summary.recentAchievements || []).length > 0 && <div className="ledger-recent"><span>RECENT</span>{summary.recentAchievements.slice(0, 3).map((achievement) => <a key={`${achievement.achievementId}-${achievement.earnedAt}`} href={`https://www.wowhead.com/achievement=${achievement.achievementId}`} target="_blank" rel="noreferrer" title={`${achievement.name} · earned ${formatEarnedAt(achievement.earnedAt)}`}><strong>{achievement.name}</strong><time dateTime={achievement.earnedAt}>{formatEarnedAt(achievement.earnedAt)}</time></a>)}</div>}
            </div>
          )}
          <div className="ledger-actions">
            <label className="ledger-search">
              <Search size={13} aria-hidden="true" />
              <input ref={searchRef} value={globalFilter} onChange={(event) => setGlobalFilter(event.target.value)} placeholder="Search achievements, categories, rewards…" disabled={!characterId} aria-label="Search achievements" />
              <kbd>{/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘ K" : "CTRL K"}</kbd>
            </label>
            <div className="ledger-action-buttons">
              <span className="comparison-control">
                <CharacterChooser
                  mode="comparison"
                  initialCharacter={selectedCharacter ? { region: selectedCharacter.region, realm: selectedCharacter.realm_slug || selectedCharacter.realm, name: "" } : null}
                  selectedCharacter={comparisonCharacter}
                  characters={characters}
                  excludeCharacterId={characterId}
                  onSelect={selectComparisonCharacter}
                  onForget={forgetRecentCharacter}
                  onMessage={setMessage}
                  reloadCharacters={reloadComparisonCharacters}
                />
                {comparisonCharacter && <button type="button" className="comparison-clear" onClick={clearComparison} aria-label={`Clear comparison with ${comparisonCharacter.name}`}><X size={12} aria-hidden="true" /> Clear compare</button>}
              </span>
              <button type="button" className={`needed-by-both ${neededByBoth ? "is-active" : ""}`} disabled={!comparisonCharacter} aria-pressed={neededByBoth} onClick={() => setNeededByBoth((current) => !current)}>Needed by both</button>
              <button className="refresh-button" disabled={!characterId || loadingPage || isRefreshing} onClick={refresh}>{isRefreshing ? "REFRESHING FROM BLIZZARD…" : "REFRESH FROM BLIZZARD"}</button>
            </div>
          </div>
        </section>
        {working && (
          <div className="tracker-working" role="status">
            <span className="animate-spin">◌</span>
            {working}
          </div>
        )}
        {characterId ? (
          <>
            <section className="v2-toolbar" aria-label="Tracker filters">
              <div className="status-segments" role="radiogroup" aria-label="Achievement status">
                {statusOptions.map(([value, label, count]) => <button type="button" role="radio" aria-checked={statusFilter === value} className={statusFilter === value ? "is-active" : ""} key={value} onClick={() => setStatusFilter(value)}>{label} <span>{count.toLocaleString()}</span></button>)}
              </div>
              <button type="button" className={`exclude-pvp-toggle ${excludePvp ? "is-active" : ""}`} aria-pressed={excludePvp} onClick={() => setExcludePvp((current) => !current)}>Exclude PvP</button>
              {facetGroups.map((group) => group.key === "priority" ? (
                <span className="priority-control-cluster" key={group.key}>
                  <V2FilterMenu groupKey={group.key} label={group.label} options={group.options} selected={facetSelections[group.key]} open={openFilter === group.key} onOpen={setOpenFilter} onToggle={toggleFacet} />
                  <PriorityLegend labels={priorityLabels} />
                  <button type="button" className="priority-edit-button" onClick={() => setEditingPriorityLabels(true)} aria-label="Edit priority labels"><Pencil size={13} /><span className="priority-edit-tooltip" role="tooltip">Edit priority labels</span></button>
                </span>
              ) : <V2FilterMenu key={group.key} groupKey={group.key} label={group.label} options={group.options} selected={facetSelections[group.key]} category={group.category} open={openFilter === group.key} onOpen={setOpenFilter} onToggle={toggleFacet} />)}
              <span className="v2-toolbar-actions"><button type="button" onClick={clearAll}>Clear all</button><button type="button" onClick={() => setSavedViewsOpen(true)}>Save this view{savedViews.length ? ` · ${savedViews.length}` : ""}</button></span>
            </section>
            {(activeFacets.length > 0 || neededByBoth || excludePvp) && <section className="active-filter-row"><span>ACTIVE</span>{neededByBoth && comparisonCharacter && <button type="button" onClick={() => setNeededByBoth(false)} aria-label={`Remove Needed by both ${comparisonCharacter.name} filter`}>Needed by both: {comparisonCharacter.name} <span aria-hidden="true">×</span></button>}{excludePvp && <button type="button" onClick={() => setExcludePvp(false)} aria-label="Include PvP achievements">PvP excluded <span aria-hidden="true">×</span></button>}{activeFacets.map((item) => <button type="button" key={`${item.groupKey}-${item.value}`} onClick={() => toggleFacet(item.groupKey, item)} aria-label={`Remove filter: ${item.groupLabel} ${item.label}`}>{item.groupLabel}: {item.label.replaceAll(" > ", " › ")} <span aria-hidden="true">×</span></button>)}<small>{total.toLocaleString()} matching · {rows.reduce((sum, row) => sum + (row.points || 0), 0).toLocaleString()} loaded points</small></section>}
            {editingPriorityLabels && <PriorityLegendEditor labels={priorityLabels} onSave={savePriorityLabels} onCancel={() => setEditingPriorityLabels(false)} />}
            {savedViewsOpen && <SavedViewsDialog views={savedViews} onSave={saveCurrentView} onOpen={openSavedView} onDelete={(name) => persistSavedViews(savedViews.filter((item) => item.name !== name))} onClose={() => setSavedViewsOpen(false)} />}
            <div
              ref={gridRef}
              className="ledger-grid"
            >
              <table className="ledger-table" style={{ width: table.getTotalSize() }}>
                <thead>
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                      {group.headers.map((header) => (
                        <th
                          className="ledger-th"
                          key={header.id}
                          style={{ width: header.getSize() }}
                        >
                          {header.isPlaceholder ? null : (
                            <>
                              <button className="ledger-sort"
                                onClick={header.column.getToggleSortingHandler()}
                              >
                                {flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                                <span>
                                  {isSorting
                                    ? "◌"
                                    : ({ asc: "↑", desc: "↓" }[
                                        header.column.getIsSorted()
                                      ] ?? "↕")}
                                </span>
                              </button>
                              <div
                                className="tracker-column-resizer"
                                onDoubleClick={() => header.column.resetSize()}
                                onMouseDown={(event) => {
                                  event.stopPropagation();
                                  header.getResizeHandler()(event);
                                }}
                                onTouchStart={(event) => {
                                  event.stopPropagation();
                                  header.getResizeHandler()(event);
                                }}
                                title="Drag to resize; double-click to reset"
                              />
                            </>
                          )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {!loadingPage && table.getRowModel().rows.length === 0 && (
                    <tr>
                      <td className="px-3 py-8 text-center text-sm text-muted" colSpan={table.getVisibleLeafColumns().length}>
                        No achievements match the current filters. Try Clear, or include Earned under Status.
                      </td>
                    </tr>
                  )}
                  {table.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => {
                        const value = cell.getValue();
                        return (
                          <td
                            className={`ledger-td ${cell.column.id === "name" ? "achievement-cell" : ""}`}
                            key={cell.id}
                            style={{ width: cell.column.getSize() }}
                            title={cell.column.id === "name" ? undefined : typeof value === "string" && value ? value : undefined}
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div
                ref={loadMoreRef}
                className="px-2 py-2 text-center text-xs text-muted"
              >
                {loadingPage
                  ? "Loading…"
                  : hasMore
                    ? "Scroll to load more…"
                    : "End of results"}
              </div>
            </div>
          </>
        ) : (
          <p className="mt-4 text-muted">Choose a character to begin.</p>
        )}
      </main>
    </Shell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/tracks" element={<Tracks />} />
      <Route path="/achievements" element={<Tracker />} />
      <Route path="/hammerlink" element={<HammerLinkImport />} />
      <Route path="/mcp-guide" element={<McpGuide />} />
      <Route path="*" element={<Navigate to="/achievements" replace />} />
    </Routes>
  );
}
