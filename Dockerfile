# Marginalia — a private literary wiki.
# No npm dependencies, so the image is just Node and the source.

FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    MARGINALIA_DATA=/data

WORKDIR /app
COPY --chown=node:node package.json server.js auth.js ./
COPY --chown=node:node public ./public

# The writing lives here; mount a volume or a host folder over it.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
