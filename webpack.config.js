const webpack = require('webpack')
const path = require('path')

const defaultMode = 'development'
const outputPath = path.resolve(__dirname, './dist/release')

const tsLoaderRules = [
    {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
    },
]

const extensions = ['.tsx', '.ts', '.js']

module.exports = [
    {
        name: 'webext',
        mode: defaultMode,
        entry: {
            background: './src/background/background.ts',
        },
        experiments: { syncWebAssembly: true, topLevelAwait: true },
        output: { path: outputPath },
        module: { rules: tsLoaderRules },
        resolve: {
            extensions: extensions,
            fallback: {
                http: false,
                https: false,
                url: false,
                util: false,
                buffer: require.resolve('buffer/'),
            },
        },
        plugins: [
            new webpack.ProvidePlugin({
                Buffer: ['buffer', 'Buffer'],
                WritableStream: ['web-streams-polyfill', 'WritableStream'],
            }),
        ],
    },
    {
        name: 'experiment',
        mode: defaultMode,
        entry: './src/experiments/irmaseal4tb/irmaseal4tb-impl.ts',
        output: {
            filename: 'irmaseal4tb-impl.js',
            path: `${outputPath}/irmaseal4tb/`,
            library: 'irmaseal4tb',
            libraryExport: 'default',
        },
        module: { rules: tsLoaderRules },
        resolve: { extensions: extensions },
    },
]
