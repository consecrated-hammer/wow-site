FROM node:25-alpine AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY achievement_tracker.py ./achievement_tracker.py
COPY scripts/sync-wowhead-achievement-releases.py ./scripts/sync-wowhead-achievement-releases.py
COPY --from=frontend-build /frontend/dist ./static
COPY site/assets/mcp-icon.png ./static/favicon.png
RUN groupadd --gid 1000 wowweb && useradd --uid 1000 --gid 1000 --create-home wowweb && mkdir -p /data && chown -R wowweb:wowweb /app /data
USER 1000:1000
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health')"
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
