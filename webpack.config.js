const webpack = require('webpack')
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const sveltePreprocess = require('svelte-preprocess')

const mode = process.env.NODE_ENV || 'development'
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
        mode,
        entry: {
            background: './src/background/background.ts',
            decryptPopup: './src/components/decryptPopup/index.ts',
            attributeSelection: './src/components/attributeSelection/index.ts',
            messageDisplay: './src/components/messageDisplay/index.ts',
        },
        experiments: { syncWebAssembly: true, topLevelAwait: true },
        output: { path: outputPath },
        module: {
            rules: [
                ...tsLoaderRules,
                {
                    test: /\.(woff|woff2|eot|ttf|otf)$/i,
                    type: 'asset/resource',
                },
                {
                    test: /\.(svelte)$/,
                    use: {
                        loader: 'svelte-loader',
                        options: {
                            preprocess: sveltePreprocess({ postcss: true }) /* emitCss: true,*/,
                        },
                    },
                },
                {
                    // required to prevent errors from Svelte on Webpack 5+, omit on Webpack 4
                    test: /node_modules\/svelte\/.*\.mjs$/,
                    resolve: {
                        fullySpecified: false,
                    },
                },
                { test: /\.(svg)$/, type: 'asset/inline' },
                { test: /\.s[ac]ss$/i, use: ['style-loader', 'css-loader', 'sass-loader'] },
            ],
        },
        resolve: {
            alias: {
                svelte: path.resolve('node_modules', 'svelte'),
            },
            extensions: ['.ts', '.mjs', '.js', '.svelte'],
            mainFields: ['svelte', 'browser', 'module', 'main'],
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
                process: 'process/browser',
            }),
            new HtmlWebpackPlugin({
                title: 'Postguard decrypt',
                template: './src/components/decryptPopup/index.html',
                filename: 'decryptPopup.html',
                chunks: ['decryptPopup'],
            }),
            new HtmlWebpackPlugin({
                title: 'Postguard attribute selection',
                template: './src/components/attributeSelection/index.html',
                filename: 'attributeSelection.html',
                chunks: ['attributeSelection'],
            }),
        ],
    },
    {
        name: 'experiment',
        mode,
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
