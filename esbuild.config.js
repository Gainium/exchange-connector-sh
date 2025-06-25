/* eslint-disable @typescript-eslint/no-require-imports */
const esbuild = require('esbuild')
const path = require('path')

const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false, // Set to true for production minification
  external: [
    // Mark all node_modules as external to avoid bundling them
    // This is important for NestJS apps as some modules need to be external
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  loader: {
    '.ts': 'ts',
    '.js': 'js',
  },
  tsconfig: 'tsconfig.json',
  metafile: true, // Generate metadata for analysis
  logLevel: 'info',
}

// Function to identify external packages automatically
const findExternalPackages = () => {
  const packageJson = require('./package.json')
  const dependencies = Object.keys(packageJson.dependencies || {})
  const devDependencies = Object.keys(packageJson.devDependencies || {})

  // Include all dependencies as external, plus common Node.js built-ins
  return [
    ...dependencies,
    ...devDependencies,
    'fs',
    'path',
    'os',
    'crypto',
    'http',
    'https',
    'url',
    'querystring',
    'stream',
    'util',
    'events',
    'buffer',
    'child_process',
    'cluster',
    'net',
    'tls',
    'dgram',
    'dns',
    'readline',
    'repl',
    'vm',
    'zlib',
  ]
}

buildOptions.external = findExternalPackages()

async function build() {
  try {
    console.log('Building with esbuild...')
    const result = await esbuild.build(buildOptions)

    if (result.metafile) {
      console.log('Build completed successfully!')
      console.log(`Output file: ${path.resolve(buildOptions.outfile)}`)

      // Optionally analyze the bundle
      const analysis = await esbuild.analyzeMetafile(result.metafile)
      console.log('\nBundle analysis:')
      console.log(analysis)
    }
  } catch (error) {
    console.error('Build failed:', error)
    process.exit(1)
  }
}

build()
