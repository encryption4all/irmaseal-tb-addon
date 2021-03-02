const webpackConfig = require('./webpack.config.js')

module.exports = (grunt) => {
    const srcDir = 'src/'
    const outDir = 'dist/'
    const outDirExtracted = `${outDir}/release/`
    const outXpi = `${outDir}/irmaseal-tb-addon.xpi`

    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),

        clean: [outDir],
        copy: {
            main: {
                files: [
                    {
                        expand: true,
                        cwd: 'resources/',
                        src: ['**'],
                        dest: outDirExtracted,
                    },
                    {
                        expand: true,
                        cwd: srcDir + '/background/',
                        src: ['**', '!**/*.ts', '!**/tsconfig*.json'],
                        dest: outDirExtracted,
                    },
                    {
                        expand: true,
                        cwd: srcDir + '/experiments/',
                        src: ['**', '!**/*.ts', '!**/tsconfig*.json'],
                        dest: outDirExtracted,
                    },
                    {
                        expand: true,
                        src: ['./licence.txt', './README.md'],
                        dest: outDirExtracted,
                    },
                ],
            },
        },
        webpack: {
            dev: webpackConfig,
            release: webpackConfig.map((config) =>
                Object.assign({}, config, { mode: 'production' })
            ),
        },
        compress: {
            main: {
                options: {
                    archive: outXpi,
                    mode: 'zip',
                },
                files: [
                    {
                        expand: true,
                        cwd: outDirExtracted,
                        src: ['**'],
                        dest: '/',
                    },
                ],
            },
        },
        eslint: {
            target: [
                srcDir + '/**/*.ts',
                srcDir + '/**/*.js',
                '!src/**/libs/**/*.js',
            ],
        },
    })

    grunt.loadNpmTasks('grunt-contrib-copy')
    grunt.loadNpmTasks('grunt-contrib-clean')
    grunt.loadNpmTasks('grunt-contrib-compress')
    grunt.loadNpmTasks('grunt-webpack')
    grunt.loadNpmTasks('grunt-eslint')

    // Default task(s).
    grunt.registerTask('default', [
        'clean',
        'copy',
        'webpack:dev',
        'compress',
        'eslint',
    ])

    grunt.registerTask('release', [
        'clean',
        'copy',
        'webpack:release',
        'compress',
        'eslint',
    ])
}
