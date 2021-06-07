const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CspHtmlWebpackPlugin = require('csp-html-webpack-plugin')

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
            sealCompose: './src/components/composePopup/sealCompose.ts',
            sealDecrypt: './src/components/decryptPopup/decryptPopup.ts',
        },
        experiments: { syncWebAssembly: true, topLevelAwait: true },
        output: { path: outputPath },
        module: { rules: tsLoaderRules },
        resolve: {
            extensions: extensions,
            fallback: { http: false, https: false, url: false, util: false },
        },
        plugins: [
            new HtmlWebpackPlugin({
                title: 'IRMAseal compose',
                template: './src/components/composePopup/sealCompose.html',
                filename: 'sealCompose.html',
                chunks: ['sealCompose'],
            }),
            new HtmlWebpackPlugin({
                title: 'IRMAseal decrypt',
                template: './src/components/decryptPopup/decryptPopup.html',
                filename: 'sealDecrypt.html',
                chunks: ['sealDecrypt'],
            }),
            new CspHtmlWebpackPlugin(),
        ],
    },
    {
        name: 'experiment',
        mode: defaultMode,
        entry: './src/experiments/irmaseal4tb-impl.ts',
        output: {
            filename: 'irmaseal4tb-impl.js',
            path: outputPath,
            library: 'irmaseal4tb',
            libraryExport: 'default',
        },
        module: { rules: tsLoaderRules },
        resolve: { extensions: extensions },
    },
]
