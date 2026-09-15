# Apify base image with Node.js 20, Playwright and preinstalled browsers.
# See https://crawlee.dev/docs/guides/docker-images
FROM apify/actor-node-playwright-chrome:20

# Check preinstalled packages
RUN npm ls crawlee apify puppeteer playwright

# Copy only package.json (not the lockfile) so npm keeps the Playwright
# version preinstalled in the image, which matches the bundled browsers.
COPY --chown=myuser package.json ./

# Install NPM packages, skip optional and development dependencies to
# keep the image small. Avoid logging too much and print the dependency
# tree for debugging.
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy the source code. Done after npm install so rebuilds after
# source-only changes are fast.
COPY --chown=myuser . ./

# Run the image. XVFB allows running headful browsers if ever needed.
CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
