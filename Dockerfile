FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY renderer ./renderer
ENV NODE_ENV=production
ENV PORT=3000
ENV NEXUSDESK_HOME=/data
ENV WATCH_DIR=/data/watch
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "src/server.js"]
