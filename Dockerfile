FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="ResolveWeave" \
  org.opencontainers.image.description="Evidence-first open-source enterprise customer service platform" \
  org.opencontainers.image.source="https://github.com/Rcloudso/resolveweave"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3001 5173

CMD ["npm", "run", "dev"]
