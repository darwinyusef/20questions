FROM node:20-alpine

WORKDIR /app

# Instalar dependencias de compilación para better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Directorio para la base de datos persistente
RUN mkdir -p /data

EXPOSE 3000

ENV NODE_ENV=production
ENV DB_DIR=/data
ENV PORT=3000

CMD ["node", "server.js"]
