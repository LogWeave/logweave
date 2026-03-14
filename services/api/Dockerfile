FROM node:24-alpine AS deps

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src/ src/
RUN pnpm build

FROM node:24-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=deps /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY package.json ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
