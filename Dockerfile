FROM oven/bun:1-alpine

# Passed in at build time: docker build --build-arg GIT_BRANCH=main --build-arg GIT_HASH=abc1234
ARG GIT_BRANCH=unknown
ARG GIT_HASH=unknown
ENV GIT_BRANCH=$GIT_BRANCH
ENV GIT_HASH=$GIT_HASH

# Run as non-root user (built into the bun image)
USER bun

WORKDIR /app

# Copy source files with correct ownership
COPY --chown=bun:bun src/ src/

VOLUME ["/rcw", "/data"]

EXPOSE 3000

# --smol reduces memory overhead on Alpine
CMD ["bun", "--smol", "src/server.ts"]
