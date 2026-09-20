const path = require('path')
const webpack = require('webpack')

// prismarine-viewer's Viewer pulls in prismarine-chunk/-block/-entity, which expect
// Node globals. These fallbacks mirror the upstream examples/web_client config.
const clientConfig = {
  entry: './src/client/index.js',
  // Content-hashed so /dist can be cached for a year: a new build is a new
  // URL. The server finds the current names by listing dist/ at startup.
  // Each config cleans its own stale hashes and keeps the other's output,
  // since all three write to dist/ at the same time.
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.[contenthash].js',
    clean: { keep: /^(worker\.|controller\.|blocksStates\/)/ }
  },
  resolve: {
    // canvas is not a core module, so it needs an alias rather than a
    // fallback — and a real shim, not `false`: entities.js calls
    // createCanvas() at runtime to draw player nametags.
    alias: {
      canvas: path.resolve(__dirname, 'src/client/shims/canvas.js')
    },
    fallback: {
      fs: false,
      net: false,
      tls: false,
      dns: false,
      child_process: false,
      perf_hooks: path.resolve(__dirname, 'src/client/shims/perf_hooks.js'),
      assert: require.resolve('assert/'),
      buffer: require.resolve('buffer/'),
      crypto: require.resolve('crypto-browserify'),
      events: require.resolve('events/'),
      path: require.resolve('path-browserify'),
      process: require.resolve('process/browser'),
      stream: require.resolve('stream-browserify'),
      util: require.resolve('util/'),
      zlib: require.resolve('browserify-zlib')
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser'
    }),
    // viewer/lib/utils.js is the Node build: it pulls loadImage out of
    // node-canvas-webgl through a safeRequire that silently yields {} when that
    // native module is absent, so textures blow up at runtime with
    // "loadImage is not a function". Upstream's own web config swaps in
    // utils.web.js (XMLHttpRequest + THREE.TextureLoader) and we need the same.
    new webpack.NormalModuleReplacementPlugin(
      // eslint-disable-next-line
      /viewer[\/|\\]lib[\/|\\]utils/,
      './utils.web.js'
    ),
    // Our WorldRenderer: same class, but it spawns our worker bundle below
    // and meshes the full 1.18+ height. See src/client/viewer/.
    new webpack.NormalModuleReplacementPlugin(
      // eslint-disable-next-line
      /prismarine-viewer[\/|\\]viewer[\/|\\]lib[\/|\\]worldrenderer\.js$/,
      path.resolve(__dirname, 'src/client/viewer/worldrenderer.js')
    )
  ],
  performance: { hints: false },
  devtool: 'source-map'
}

// The mesher worker, replacing prismarine-viewer/public/worker.js (63 MB: it
// bundles minecraft-data for every edition and version, and the Viewer starts
// several copies). Same recipe as upstream's own webpack.config.js, minus
// Bedrock's per-version data, which a mineflayer bot can never need. Bedrock's
// common/ files stay: minecraft-data's index walks both editions' version
// tables at load and throws on a missing one.
const allowedWorkerFiles = ['blocks', 'blockCollisionShapes', 'tints', 'blockStates',
  'biomes', 'features', 'version', 'legacy', 'versions', 'protocolVersions']

const workerConfig = {
  entry: './src/client/viewer/worker.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'worker.[contenthash].js',
    clean: { keep: /^(bundle\.|controller\.|blocksStates\/)/ }
  },
  resolve: { fallback: clientConfig.resolve.fallback },
  module: {
    rules: [{
      test: /prismarine-viewer[\/|\\]viewer[\/|\\]lib[\/|\\]models\.js$/,
      use: path.resolve(__dirname, 'src/client/viewer/models-loader.js')
    }]
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser'
    })
  ],
  externals: [
    function ({ context, request }, cb) {
      if (context.includes('minecraft-data') && request.endsWith('.json')) {
        const fileName = request.split('/').pop().replace('.json', '')
        const bedrockData = request.includes('/bedrock/') && !request.includes('/bedrock/common/')
        if (bedrockData || !allowedWorkerFiles.includes(fileName)) {
          cb(null, [])
          return
        }
      }
      cb()
    }
  ],
  performance: { hints: false },
  devtool: 'source-map'
}

const controllerConfig = {
  ...clientConfig,
  entry: './src/client/controller.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'controller.[contenthash].js',
    clean: { keep: /^(bundle\.|worker\.|blocksStates\/)/ }
  }
}

module.exports = [clientConfig, workerConfig, controllerConfig]
