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
        resolve: { extensions: extensions },
    },
    {
        name: 'experiment',
        mode: defaultMode,
        entry: './src/experiments/msgHdr-impl.ts',
        output: {
            filename: '[name].js',
            path: outputPath,
            library: '[name]',
            libraryExport: 'default',
        },
        module: { rules: tsLoaderRules },
        resolve: { extensions: extensions },
    },
]
