FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package*.json ./
RUN npm install --production
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
EXPOSE 3012
CMD ["node", "dist/index.js"]
