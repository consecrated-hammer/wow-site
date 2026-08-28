export const tracks = [
  ['Adventurer',[266,269,272,276,279,282]], ['Veteran',[279,282,285,289,292,295]], ['Champion',[292,295,298,302,305,308]], ['Hero',[305,308,311,315,318,321]], ['Myth',[318,321,324,328,331,334]]
];

// Keep the player-facing source guidance with the season data, so the UI does
// not imply that every item on a track has one exact source.
export const trackSources = {
  Adventurer: {
    summary: 'Outdoor content and entry-level endgame activities.',
    sources: ['World quests and outdoor events', 'Early delves and easy prey', 'Warbound and catch-up rewards'],
  },
  Veteran: {
    summary: 'The regular path from accessible group and progression content.',
    sources: ['Raid Finder', 'Heroic dungeons', 'Delves and weekly outdoor rewards'],
  },
  Champion: {
    summary: 'The bridge into organised endgame content.',
    sources: ['Normal raid', 'Mythic+ end-of-run: +2 to +5', 'Mid-tier delves and prey', 'Eligible Great Vault rewards'],
  },
  Hero: {
    summary: 'High-end endgame rewards.',
    sources: ['Heroic raid', 'Mythic+ end-of-run: +6 and above (caps at Hero 3/6 from +10)', 'Mythic+ Great Vault: +2 to +9', 'Top-tier delves and prey'],
  },
  Myth: {
    summary: 'The highest upgrade track from the hardest PvE content.',
    sources: ['Mythic raid', 'Mythic+ Great Vault: +10 and above (Myth 1/6)', 'No Myth-track end-of-run drop; +10 and above caps at Hero 3/6'],
  },
};
