FROM node:24-alpine AS deps

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src/ src/
RUN pnpm build

FROM node:24-alpine

WORKDIR /app

COPY --from=deps /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY package.json ./

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000

CMD ["node", "dist/index.js"]
