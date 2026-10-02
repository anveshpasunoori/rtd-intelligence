FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY db ./db
COPY test ./test
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
