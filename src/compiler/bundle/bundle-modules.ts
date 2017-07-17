import { BuildConfig, BuildContext, Bundle, ComponentMeta, Diagnostic,
  Manifest, ModuleResults, StencilSystem } from '../interfaces';
import { buildError, buildWarn, catchError, generateBanner, normalizePath } from '../util';
import { formatDefineComponents, formatJsBundleFileName, generateBundleId } from '../../util/data-serialize';


export function bundleModules(config: BuildConfig, ctx: BuildContext, userManifest: Manifest) {
  // create main module results object
  const moduleResults: ModuleResults = {
    bundles: {},
    diagnostics: []
  };

  // do bundling if this is not a change build
  // or it's a change build that has either changed modules or components
  const doBundling = (!ctx.isChangeBuild || ctx.changeHasComponentModules || ctx.changeHasNonComponentModules);

  const timeSpan = config.logger.createTimeSpan(`bundle modules started`, !doBundling);

  return Promise.all(userManifest.bundles.map(userBundle => {
    return generateDefineComponents(config, ctx, userManifest, userBundle, moduleResults);

  })).catch(err => {
    catchError(moduleResults.diagnostics, err);

  }).then(() => {
    timeSpan.finish('bundle modules finished');
    return moduleResults;
  });
}


function generateDefineComponents(config: BuildConfig, ctx: BuildContext, userManifest: Manifest, userBundle: Bundle, moduleResults: ModuleResults) {
  const sys = config.sys;

  const bundleComponentMeta = userBundle.components.map(userBundleComponentTag => {
    const cmpMeta = userManifest.components.find(c => c.tagNameMeta === userBundleComponentTag);
    if (!cmpMeta) {
      const d = buildError(moduleResults.diagnostics);
      d.messageText = `Unable to find component "${userBundleComponentTag}" in available config and collection.`;
    }
    return cmpMeta;
  }).filter(c => !!c);

  if (!bundleComponentMeta.length) {
    const d = buildError(moduleResults.diagnostics);
    d.messageText = `No components found to bundle`;
    return Promise.resolve(moduleResults);
  }

  const bundleId = generateBundleId(userBundle.components);

  // loop through each bundle the user wants and create the "defineComponents"
  return bundleComponentModules(sys, ctx, bundleComponentMeta, bundleId, moduleResults).then(bundleDetails => {

    // format all the JS bundle content
    // insert the already bundled JS module into the defineComponents function
    let moduleContent = formatDefineComponents(
      config.namespace, STENCIL_BUNDLE_ID,
      bundleDetails.content, bundleComponentMeta
    );

    if (config.minifyJs) {
      // minify js
      const minifyJsResults = sys.minifyJs(moduleContent);
      minifyJsResults.diagnostics.forEach(d => {
        moduleResults.diagnostics.push(d);
      });

      if (minifyJsResults.output) {
        moduleContent = minifyJsResults.output;
      }
    }

    if (config.hashFileNames) {
      // create module id from hashing the content
      moduleResults.bundles[bundleId] = sys.generateContentHash(moduleContent, config.hashedFileNameLength);

    } else {
      // create module id from list of component tags in this file
      moduleResults.bundles[bundleId] = userBundle.components.sort().join('.').toLowerCase();

      if (moduleResults.bundles[bundleId].length > 50) {
        // can get a lil too long, so let's simmer down
        moduleResults.bundles[bundleId] = moduleResults.bundles[bundleId].substr(0, 50);
      }
    }

    // replace the known bundle id template with the newly created bundle id
    moduleContent = moduleContent.replace(MODULE_ID_REGEX, moduleResults.bundles[bundleId]);

    if (bundleDetails.writeFile) {
      // create the file name and path of where the bundle will be saved
      const moduleFileName = formatJsBundleFileName(moduleResults.bundles[bundleId]);
      const moduleFilePath = sys.path.join(config.buildDir, config.namespace.toLowerCase(), moduleFileName);

      ctx.moduleBundleCount++;

      ctx.filesToWrite[moduleFilePath] = generateBanner(config) + moduleContent;
    }

  }).catch(err => {
    catchError(moduleResults.diagnostics, err);

  }).then(() => {
    return moduleResults;
  });
}


function bundleComponentModules(sys: StencilSystem, ctx: BuildContext, bundleComponentMeta: ComponentMeta[], bundleId: string, moduleResults: ModuleResults) {
  const bundleDetails: ModuleBundleDetails = {};

  if (ctx.isChangeBuild && !ctx.changeHasComponentModules && !ctx.changeHasNonComponentModules && ctx.moduleBundleOutputs[bundleId]) {
    // don't bother bundling if this is a change build but
    // none of the changed files are modules or components
    bundleDetails.content = ctx.moduleBundleOutputs[bundleId];
    bundleDetails.writeFile = false;
    return Promise.resolve(bundleDetails);
  }

  const entryFileLines: string[] = [];

  // loop through all the components this bundle needs
  // and generate a string of the JS file to be generated
  bundleComponentMeta.sort((a, b) => {
    if (a.tagNameMeta.toLowerCase() < b.tagNameMeta.toLowerCase()) return -1;
    if (a.tagNameMeta.toLowerCase() > b.tagNameMeta.toLowerCase()) return 1;
    return 0;

  }).forEach(cmpMeta => {
    // create a full path to the modules to import
    let importPath = cmpMeta.componentPath;

    // manually create the content for our temporary entry file for the bundler
    entryFileLines.push(`import { ${cmpMeta.componentClass} } from "${importPath}";`);

    // export map should always use UPPER CASE tag name
    entryFileLines.push(`exports['${cmpMeta.tagNameMeta.toUpperCase()}'] = ${cmpMeta.componentClass};`);
  });

  // create the entry file for the bundler
  const moduleBundleInput = entryFileLines.join('\n');

  if (ctx.isChangeBuild && ctx.changeHasComponentModules && !ctx.changeHasNonComponentModules) {
    // this is a change build, and there are no non-component changes
    // but there are component changes, so lets hash our files together and compare
    // if the original content is the same then we don't need to continue the bundle

    // loop through all the changed typescript filename and see if there are corresponding js filenames
    // if there are no filenames that match then let's not bundle
    // yes...there could be two files that have the same filename in different directories
    // but worst case scenario is that both of them run their bundling, which isn't a performance problem
    const hasChangedFileName = bundleComponentMeta.some(cmpMeta => {
      const distFileName = sys.path.basename(cmpMeta.componentPath, '.js');
      return ctx.changedFiles.some(f => {
        const changedFileName = sys.path.basename(f);
        return (changedFileName === distFileName + '.ts' || changedFileName === distFileName + '.tsx');
      });
    });

    if (!hasChangedFileName && ctx.moduleBundleOutputs[bundleId]) {
      // don't bother bundling, none of the changed files have the same filename
      bundleDetails.content = ctx.moduleBundleOutputs[bundleId];
      bundleDetails.writeFile = false;
      return Promise.resolve(bundleDetails);
    }
  }


  // start the bundler on our temporary file
  return sys.rollup.rollup({
    entry: STENCIL_BUNDLE_ID,
    plugins: [
      sys.rollup.plugins.nodeResolve({
        jsnext: true,
        main: true
      }),
      sys.rollup.plugins.commonjs({
        include: 'node_modules/**',
        sourceMap: false
      }),
      entryInMemoryPlugin(STENCIL_BUNDLE_ID, moduleBundleInput),
      transpiledInMemoryPlugin(sys, ctx)
    ],
    onwarn: createOnWarnFn(bundleComponentMeta, moduleResults.diagnostics)

  }).catch(err => {
    throw err;
  })

  .then(rollupBundle => {
    // generate the bundler results
    const results = rollupBundle.generate({
      format: 'es'
    });

    // module bundling finished, assign its content to the user's bundle
    bundleDetails.content = `function importComponent(exports, h, t, Ionic) {\n${results.code.trim()}\n}`;

    // cache for later
    ctx.moduleBundleOutputs[bundleId] = bundleDetails.content;

    bundleDetails.writeFile = true;
    return bundleDetails;
  });
}

interface ModuleBundleDetails {
  content?: string;
  writeFile?: boolean;
}


function createOnWarnFn(bundleComponentMeta: ComponentMeta[], diagnostics: Diagnostic[]) {
  const previousWarns: {[key: string]: boolean} = {};

  return function onWarningMessage(warning: any) {
    if (warning && warning.message in previousWarns) {
      return;
    }
    previousWarns[warning.message] = true;

    let label = bundleComponentMeta.map(c => c.tagNameMeta).join(', ').trim();
    if (label.length) {
      label += ': ';
    }

    buildWarn(diagnostics).messageText = label + warning.toString();
  };
}


function transpiledInMemoryPlugin(sys: StencilSystem, ctx: BuildContext) {
  return {
    name: 'transpiledInMemoryPlugin',

    resolveId(importee: string, importer: string): string {
      if (!sys.path.isAbsolute(importee)) {
        importee = sys.path.resolve(importer ? sys.path.dirname(importer) : sys.path.resolve(), importee);

        if (importee.indexOf('.js') === -1) {
          importee += '.js';
        }
      }

      const tsFileNames = Object.keys(ctx.moduleFiles);
      for (var i = 0; i < tsFileNames.length; i++) {
        if (ctx.moduleFiles[tsFileNames[i]].jsFilePath === importee) {
          return importee;
        }
      }

      return null;
    },

    load(sourcePath: string): string {
      sourcePath = normalizePath(sourcePath);

      if (typeof ctx.jsFiles[sourcePath] === 'string') {
        return ctx.jsFiles[sourcePath];
      }

      const jsText = sys.fs.readFileSync(sourcePath, 'utf-8' );
      ctx.moduleFiles[sourcePath] = {
        jsFilePath: sourcePath,
      };
      ctx.jsFiles[sourcePath] = jsText;

      return jsText;
    }
  };
}


function entryInMemoryPlugin(entryKey: string, moduleBundleInput: string) {
  // used just so we don't have to write a temporary file to disk
  // just to turn around and immediately have rollup open and read it
  return {
    name: 'entryInMemoryPlugin',
    resolveId(importee: string): string {
      if (importee === entryKey) {
        return entryKey;
      }
      return null;
    },
    load(sourcePath: string): string {
      if (sourcePath === entryKey) {
        return moduleBundleInput;
      }
      return null;
    }
  };
}


const STENCIL_BUNDLE_ID = '__STENCIL__BUNDLE__ID__';
const MODULE_ID_REGEX = new RegExp(STENCIL_BUNDLE_ID, 'g');
