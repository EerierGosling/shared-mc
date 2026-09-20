FROM node:22-slim

WORKDIR /app

COPY package*.json ./
# ci, not install: it installs exactly what package-lock.json pins and fails if
# the lockfile and package.json disagree, so the image cannot drift.
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# .git is not in the image; pass --build-arg COMMIT=$(git rev-parse --short HEAD).
ARG COMMIT=unknown
ENV COMMIT=$COMMIT
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Every bot's world copy lives on the heap; the default old-space cap (about
# 2 GB on a 64-bit build) is what MAX_BOTS is sized against. Raise both
# together if the container gets more memory.
CMD ["node", "--max-old-space-size=2048", "src/server/index.js"]
