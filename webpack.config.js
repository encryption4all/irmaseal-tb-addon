const webpack = require('webpack')
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')

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
            decryptPopup: './src/components/decryptPopup/index.ts',
        },
        experiments: { syncWebAssembly: true, topLevelAwait: true },
        output: { path: outputPath },
        module: {
            rules: [
                ...tsLoaderRules,
                {
                    test: /\.css$/i,
                    use: ['style-loader', 'css-loader'],
                },
                {
                    test: /\.(woff|woff2|eot|ttf|otf)$/i,
                    type: 'asset/resource',
                },
            ],
        },
        resolve: {
            extensions: extensions,
            fallback: {
                http: false,
                https: false,
                url: false,
                util: require.resolve('util/'),
                buffer: require.resolve('buffer/'),
            },
        },
        plugins: [
            new webpack.ProvidePlugin({
                Buffer: ['buffer', 'Buffer'],
                WritableStream: ['web-streams-polyfill', 'WritableStream'],
                process: 'process/browser',
            }),
            new HtmlWebpackPlugin({
                title: 'Postguard decrypt',
                template: './src/components/decryptPopup/index.html',
                filename: 'decryptPopup.html',
                chunks: ['decryptPopup'],
            }),
        ],
    },
    {
        name: 'experiment',
        mode: defaultMode,
        entry: './src/experiments/pg4tb/pg4tb-impl.ts',
        output: {
            filename: 'pg4tb-impl.js',
            path: `${outputPath}/pg4tb/`,
            library: 'pg4tb',
            libraryExport: 'default',
        },
        module: { rules: tsLoaderRules },
        resolve: { extensions: extensions },
    },
]
