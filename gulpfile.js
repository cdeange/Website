'use strict';

// Include Gulp & tools we'll use
var gulp = require('gulp');
var $ = require('gulp-load-plugins')();
var gutil = require('gulp-util');
var argv = require('yargs').argv;
var del = require('del');
var run = require('gulp-run');
var browserSync = require('browser-sync');
var merge = require('merge-stream');
var path = require('path');
var fs = require('fs');
var glob = require('glob-all');
var packageJson = require('./package.json');
var crypto = require('crypto');
var ensureFiles = require('./tasks/ensure-files.js');

var AUTOPREFIXER_BROWSERS = [
  'ie >= 10',
  'ie_mob >= 10',
  'ff >= 30',
  'chrome >= 34',
  'safari >= 7',
  'opera >= 23',
  'ios >= 7',
  'android >= 4.4',
  'bb >= 10'
];

var DIST = 'dist';

var dist = function(subpath) {
  return !subpath ? DIST : path.join(DIST, subpath);
};

var styleTask = function(stylesPath, srcs) {
  return gulp.src(srcs.map(function(src) {
      return path.join('app', stylesPath, src);
    }))
    .pipe($.changed(stylesPath, {extension: '.css'}))
    .pipe($.autoprefixer(AUTOPREFIXER_BROWSERS))
    .pipe(gulp.dest('.tmp/' + stylesPath))
    .pipe($.minifyCss())
    .pipe(gulp.dest(dist(stylesPath)))
    .pipe($.size({title: stylesPath}));
};

var imageOptimizeTask = function(src, dest) {
  return gulp.src(src)
    .pipe($.imagemin({
      progressive: true,
      interlaced: true
    }))
    .pipe(gulp.dest(dest))
    .pipe($.size({title: 'images'}));
};

var optimizeHtmlTask = function(src, dest) {
  var assets = $.useref.assets({
    searchPath: ['.tmp', 'app']
  });

  return gulp.src(src)
    .pipe(assets)
    // Concatenate and minify JavaScript
    .pipe($.if('*.js', $.uglify({
      preserveComments: 'some'
    })))
    // Concatenate and minify styles
    // In case you are still using useref build blocks
    .pipe($.if('*.css', $.minifyCss()))
    .pipe(assets.restore())
    .pipe($.useref())
    // Minify any HTML
    .pipe($.if('*.html', $.minifyHtml({
      quotes: true,
      empty: true,
      spare: true
    })))
    // Output files
    .pipe(gulp.dest(dest))
    .pipe($.size({
      title: 'html'
    }));
};

gulp.task('reload', function(done) {
  browserSync.reload();
  if (done && typeof done === 'function') {
    done();
  }
});

// Compile and automatically prefix stylesheets
gulp.task('styles', function() {
  return styleTask('styles', ['**/*.css']);
});

gulp.task('elements', function() {
  return styleTask('elements', ['**/*.css']);
});

// Ensure that we are not missing required files for the project
// "dot" files are specifically tricky due to them being hidden on
// some systems.
gulp.task('ensureFiles', function(cb) {
  var requiredFiles = ['.jscsrc', '.jshintrc', '.bowerrc'];

  ensureFiles(requiredFiles.map(function(p) {
    return path.join(__dirname, p);
  }), cb);
});

// Lint JavaScript
gulp.task('lint', gulp.series('ensureFiles', function() {
  return gulp.src([
      'app/scripts/**/*.js',
      'app/elements/**/*.js',
      'app/elements/**/*.html',
      'gulpfile.js'
    ])
    .pipe(browserSync.reload({
      stream: true,
      once: true
    }))

  // JSCS has not yet a extract option
  .pipe($.if('*.html', $.htmlExtract({strip: true})))
  .pipe($.jshint())
  .pipe($.jscs())
  .pipe($.jscsStylish.combineWithHintResults())
  .pipe($.jshint.reporter('jshint-stylish'))
  .pipe($.if(!browserSync.active, $.jshint.reporter('fail')));
}));

// Optimize images
gulp.task('images', function() {
  return imageOptimizeTask('app/images/**/*', dist('images'));
});

// Copy all files at the root level (app)
gulp.task('copy', function() {
  var app = gulp.src([
    'app/*',
    '!app/test',
    '!app/elements',
    '!app/bower_components',
    '!app/cache-config.json',
    '!**/.DS_Store'
  ], {
    dot: true
  }).pipe(gulp.dest(dist()));

  // Copy over only the bower_components we need
  // These are things which cannot be vulcanized
  var bower = gulp.src([
    'app/bower_components/{webcomponentsjs,platinum-sw,sw-toolbox,promise-polyfill}/**/*'
  ]).pipe(gulp.dest(dist('bower_components')));

  var acme = gulp.src([
    'app/acme-challenge/*'
  ]).pipe(gulp.dest(dist('acme-challenge')));

  var yaml = gulp.src([
    'app/app.yaml'
  ]).pipe(gulp.dest(dist()));

  return merge(app, bower, yaml, acme)
    .pipe($.size({
      title: 'copy'
    }));
});

// Copy web fonts to dist
gulp.task('fonts', function() {
  return gulp.src(['app/fonts/**'])
    .pipe(gulp.dest(dist('fonts')))
    .pipe($.size({
      title: 'fonts'
    }));
});

// Scan your HTML for assets & optimize them
gulp.task('html', function() {
  return optimizeHtmlTask(
    ['app/**/*.html', '!app/{elements,test,bower_components}/**/*.html'],
    dist());
});

// Vulcanize granular configuration
gulp.task('vulcanize', function() {
  return gulp.src('app/elements/elements.html')
    .pipe($.vulcanize({
      stripComments: true,
      inlineCss: true,
      inlineScripts: true
    }))
    .pipe(gulp.dest(dist('elements')))
    .pipe($.size({title: 'vulcanize'}));
});

// Generate config data for the <sw-precache-cache> element.
// This include a list of files that should be precached, as well as a (hopefully unique) cache
// id that ensure that multiple projects don't share the same Cache Storage.
// This task does not run by default, but if you are interested in using service worker caching
// in your project, please enable it within the 'default' task.
// for more context.
gulp.task('cache-config', function(callback) {
  var dir = dist();
  var config = {
    cacheId: packageJson.name || path.basename(__dirname),
    disabled: false
  };

  glob([
    'index.html',
    './',
    'bower_components/webcomponentsjs/webcomponents-lite.min.js',
    '{elements,scripts,styles}/**/*.*'],
    {cwd: dir}, function(error, files) {
    if (error) {
      callback(error);
    } else {
      config.precache = files;

      var md5 = crypto.createHash('md5');
      md5.update(JSON.stringify(config.precache));
      config.precacheFingerprint = md5.digest('hex');

      var configPath = path.join(dir, 'cache-config.json');
      fs.writeFile(configPath, JSON.stringify(config), callback);
    }
  });
});

// Clean output directory
gulp.task('clean', function() {
  return del(['.tmp', dist()]);
});

// Watch files for changes & reload
gulp.task('serve', gulp.series(gulp.parallel('lint', 'styles', 'elements'), function() {
  run('dev_appserver.py app --port=3000').exec();
  browserSync({
    notify: false,
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function(snippet) {
          return snippet;
        }
      }
    },
    // Run as an https by uncommenting 'https: true'
    // Note: this uses an unsigned certificate which on first access
    //       will present a certificate warning in the browser.
    // https: true,
    proxy: 'localhost:3000'
  });

  gulp.watch(['app/styles/**/*.css']).on('change', gulp.series('styles', 'reload'));
  gulp.watch(['app/elements/**/*.css']).on('change', gulp.series('elements', 'reload'));
  gulp.watch(['app/**/{*.js,*.html}']).on('change', gulp.series('lint', 'reload'));
  gulp.watch(['app/images/**/*']).on('change', gulp.series('images', 'reload'));
}));

// Build production files, the default task
gulp.task('default',
  gulp.series('clean',
    gulp.parallel('copy', 'styles'),
    'elements',
    gulp.parallel('lint', 'images', 'fonts', 'html'),
    'vulcanize'
  )
);

// Build and serve the output from the dist build
gulp.task('serve:dist', gulp.series('default', function() {
  run('dev_appserver.py ' + dist() + ' --port=3000').exec();
  browserSync({
    notify: false,
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function(snippet) {
          return snippet;
        }
      }
    },
    // Run as an https by uncommenting 'https: true'
    // Note: this uses an unsigned certificate which on first access
    //       will present a certificate warning in the browser.
    // https: true,
    proxy: 'localhost:3000'
  });
}));

gulp.task('deploy', gulp.series('default', function() {
  if (argv.project === undefined) {
    throw new gutil.PluginError({
      plugin: 'deploy',
      message: 'gulp deploy requires --project argument'
    });
  }

  var command = 'gcloud app deploy ' + dist('app.yaml') + ' --project ' + argv.project + ' -v 1';
  return run(command).exec();
}));

// Load custom tasks from the `tasks` directory
try {
  require('require-dir')('tasks');
} catch (err) {}
