FROM node:22-slim

WORKDIR /app

COPY package*.json ./
# ci, not install: it installs exactly what package-lock.json pins and fails if
# the lockfile and package.json disagree, so the image cannot drift.
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server/index.js"]
