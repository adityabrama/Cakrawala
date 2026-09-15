# Optional container workflow. `npm run dev` on the host remains the primary
# way to run CAKRAWALA; this image runs the same dev server (Vite + proxies +
# intelligence engine) inside a container.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development \
    HOST=0.0.0.0 \
    PORT=5173

# Native deps of sharp/puppeteer are not needed to serve the app; skip
# their downloads to keep the image small.
ENV PUPPETEER_SKIP_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

EXPOSE 5173
VOLUME ["/app/.gev-intel"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:5173/api/intel/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
