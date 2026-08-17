FROM node:24-alpine

WORKDIR /app

COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY site/ ./site/

ENV PORT=80
EXPOSE 80

CMD ["node", "server.mjs"]
