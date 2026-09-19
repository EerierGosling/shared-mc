const path = require('path')
const webpack = require('webpack')

// prismarine-viewer's Viewer pulls in prismarine-chunk/-block/-entity, which expect
// Node globals. These fallbacks mirror the upstream examples/web_client config.
module.exports = {
  entry: './src/client/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js'
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
    })
  ],
  performance: { hints: false },
  devtool: 'source-map'
}
