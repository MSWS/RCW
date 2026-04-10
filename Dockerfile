FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts .
COPY public/ public/
VOLUME ["/rcw", "/data"]
EXPOSE 3000
CMD ["bun", "server.ts", "--rcw", "/rcw", "--state", "/data/rcw_reader_state.json"]
