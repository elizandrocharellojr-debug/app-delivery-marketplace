FROM node:22-slim

WORKDIR /app

# Instala só as dependências primeiro (aproveita cache do Docker quando só o
# código muda, sem mexer no package.json).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia o resto do código (o .dockerignore evita levar node_modules, data/,
# .env e outros arquivos que não devem ir pra dentro da imagem).
COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

# O banco de dados e os uploads ficam no volume persistente montado em
# /app/data (configurado no fly.toml) - por isso não são copiados pra
# dentro da imagem, e continuam existindo entre deploys/reinícios.
CMD ["node", "server.js"]
