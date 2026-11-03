FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/planet-live.db
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
