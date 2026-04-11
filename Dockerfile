FROM oven/bun:1-alpine

# Run as non-root user (built into the bun image)
USER bun

WORKDIR /app

# Copy source files with correct ownership
COPY --chown=bun:bun src/ src/

VOLUME ["/rcw", "/data"]

EXPOSE 3000

# --smol reduces memory overhead on Alpine
CMD ["bun", "--smol", "src/server.ts"]
