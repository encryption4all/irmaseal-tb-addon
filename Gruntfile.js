const webpackConfig = require('./webpack.config.js')

module.exports = (grunt) => {
    const srcDir = 'src/'
    const outDir = 'dist/'
    const outDirExtracted = `${outDir}/release/`
    const outXpi = `${outDir}/postguard-tb-addon-<%= manifest.version %>.xpi`
    const resourceDir = 'resources/'

    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),
        manifest: grunt.file.readJSON('resources/manifest.json'),

        clean: [outDir],
        copy: {
            main: {
                files: [
                    {
                        expand: true,
                        cwd: 'resources/',
                        src: ['**', '!updates.json'],
                        dest: outDirExtracted,
                    },
                    {
                        expand: true,
                        cwd: 'resources/',
                        src: ['updates.json'],
                        dest: outDir,
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
            target: [srcDir + '/**/*.ts', srcDir + '/**/*.js', '!src/**/libs/**/*.js'],
        },
        watch: {
            scripts: {
                files: [
                    srcDir + '**/*',
                    resourceDir + '**/*',
                    'webpack.config.js',
                    'tsconfig.json',
                ],
                tasks: ['default'],
            },
            configFiles: {
                files: ['Gruntfile.js', 'webpack.config.js', 'tsconfig.json'],
                options: {
                    reload: true,
                },
            },
        },
    })

    grunt.loadNpmTasks('grunt-contrib-copy')
    grunt.loadNpmTasks('grunt-contrib-clean')
    grunt.loadNpmTasks('grunt-contrib-compress')
    grunt.loadNpmTasks('grunt-webpack')
    grunt.loadNpmTasks('grunt-eslint')
    grunt.loadNpmTasks('grunt-contrib-watch')

    // Default task(s).
    grunt.registerTask('default', ['clean', 'copy', 'webpack:dev', 'compress', 'eslint'])

    grunt.registerTask('release', ['clean', 'copy', 'webpack:release', 'compress', 'eslint'])
}
