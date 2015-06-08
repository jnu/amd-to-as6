var falafel = require('falafel');
var beautify = require('js-beautify').js_beautify;
var escodegen = require('escodegen');

module.exports = convert;

/**
 * Converts some code from AMD to ES6
 * @param {string} source
 * @param {object} [options]
 * @returns {string}
 */
function convert (source, options) {

    options = options || {};

    var dependenciesMap = {};
    var syncRequires = [];
    var staticSyncRequires = [];
    var usedVarNames = [];
    var requiresWithSideEffects = [];
    var mainCallExpression = null;
    var importNameGenerator = options.logicalName ?
        makeLogicalImportName :
        makeImportName;

    var result = falafel(source, function (node) {

        if (isNamedDefine(node)) {
            throw new Error('Found a named define - this is not supported.');
        }

        if (isDefineUsingIdentifier(node)) {
            throw new Error('Found a define using a variable as the callback - this is not supported.');
        }

        if (isModuleDefinition(node)) {

            if (mainCallExpression) {
                throw new Error('Found multiple module definitions in one file.');
            }

            mainCallExpression = node;
        }

        if (isVariableDeclarator(node)) {
            usedVarNames.push(node.id.name);
        }

        else if (isSyncRequire(node)) {
            if (isStaticRequire(node)) {
                staticSyncRequires.push(node);
            } else {
                syncRequires.push(node);
            }
        }

        else if (isRequireWithNoCallback(node)) {
            requiresWithSideEffects.push(node);
        }

        else if (isRequireWithDynamicModuleName(node)) {
            throw new Error('Dynamic module names are not supported.');
        }

    });

    // no module definition found - return source untouched
    if (!mainCallExpression) {
        return source;
    }

    var moduleDeps = mainCallExpression.arguments.length > 1 ? mainCallExpression.arguments[0] : null;
    var moduleFunc = mainCallExpression.arguments[mainCallExpression.arguments.length > 1 ? 1 : 0];
    var hasAMDDeps = moduleDeps && moduleDeps.elements.length > 0;
    var hasCJSDeps = moduleFunc && moduleFunc.type === 'FunctionExpression' && hasLocalRequire(moduleFunc, moduleDeps);

    if (hasAMDDeps) {
        var modulePaths = moduleDeps.elements.map(function (node) {
            return node.value;
        });

        var importNames = moduleFunc.params.map(function (param) {
            return param.name;
        });

        extend(dependenciesMap, modulePaths.reduce(function (obj, path, index) {
            obj[path] = importNames[index] || null;
            return obj;
        }, {}));
    }

    if (hasCJSDeps) {
        var varDeclarationsToRewrite = [];
        // Find names for the require() call expressions that will always be
        // called when the module is loaded. These must be in the first level
        // of the moduleFunc subtree - not inside any function or conditional.
        staticSyncRequires.forEach(function(node) {
            var $dec = node.parent;
            var $var = $dec.parent;
            var path = node.arguments[0].value;
            var name = $dec.id && $dec.id.name;

            // If the require() is used in an expression, we need to give the
            // import a name. Add it to the standard syncRequire handling.
            if ($dec.type === 'CallExpression' || $dec.type === 'BinaryExpression') {
                syncRequires.push(node);
            }
            // If this is a typical CJS-style require(), being assigned to a
            // var, then extract the path and store the declaration to be
            // rewritten later.
            else if (name && $var.type === 'VariableDeclaration') {
                dependenciesMap[path] = name;

                $dec.update('', { newline: true });

                $var.declarations = $var.declarations.filter(function(dec) {
                    return dec !== $dec;
                });

                if (varDeclarationsToRewrite.indexOf($var) < 0) {
                    varDeclarationsToRewrite.push($var);
                }
            }
            // Catch anonymous require() calls as well and store them to be
            // updated with the other side-effect imports.
            else {
                if (!dependenciesMap.hasOwnProperty(path)) {
                    dependenciesMap[path] = null;
                }
                $dec.update('', { newline: true });
            }
        });

        // Rewrite var declarations without the require() statement. If the
        // var declaration only contained the require(), remove it.
        varDeclarationsToRewrite.forEach(function(node) {
            if (!node.declarations.length) {
                node.update('', { newline: true });
            } else {
                node.update(escodegen.generate(node), { newline: true });
            }
        });
    }
    // If there are no true CommonJS-style requires, then add the static
    // requires back with the other syncRequires.
    else {
        syncRequires = syncRequires.concat(staticSyncRequires);
    }

    syncRequires.forEach(function (node) {
        var moduleName = node.arguments[0].value;

        // if no import name assigned then create one
        if (!dependenciesMap[moduleName]) {
            dependenciesMap[moduleName] = importNameGenerator(usedVarNames, moduleName);
        }

        // replace with the import name
        node.update(dependenciesMap[moduleName]);
    });

    requiresWithSideEffects.forEach(function (node) {

        // get the module names
        var moduleNames = node.arguments[0].elements.map(function (node) {
            return node.value;
        });

        // make sure these modules are imported
        moduleNames.forEach(function (moduleName) {
            if (!dependenciesMap.hasOwnProperty(moduleName)) {
                dependenciesMap[moduleName] = null;
            }
        });

        // remove node
        node.parent.update('', { newline: true });
    });

    // start with import statements
    var moduleCode = getImportStatements(dependenciesMap);

    // add modules code
    moduleCode += getModuleCode(moduleFunc);

    // fix indentation
    if (options.beautify) {
        moduleCode = beautify(moduleCode);

        // jsbeautify doesn't understand es6 module syntax yet
        moduleCode = moduleCode.replace(/export[\s\S]default[\s\S]/, 'export default ');
    }

    // update the node with the new es6 code
    mainCallExpression.parent.update(moduleCode);

    return result.toString();
}

/**
 * Takes an object where the keys are module paths and the values are
 * the import names and returns the import statements as a string.
 * @param {object} dependencies
 * @returns {string}
 */
function getImportStatements (dependencies) {
    var statements = [];

    for (var key in dependencies) {
        if (dependencies.hasOwnProperty(key)) {
            statements.push(getImportStatement(key, dependencies[key]));
        }
    }

    return statements.join('\n');
}

/**
 * Create an ES6 import statement from path and name
 * @param  {string} path Path to module
 * @param  {string} [name] Name of module. If not passed, a side-effect import is created
 * @return {string}
 */
function getImportStatement(path, name) {
    return !name ?
        'import \'' + path + '\';' :
        'import ' + name + ' from \'' + path + '\';';
}

/**
 * Updates the return statement of a FunctionExpression to be an 'export default'.
 * @param {object} functionExpression
 */
function updateReturnStatement (functionExpression) {
    functionExpression.body.body.forEach(function (node) {
        if (node.type === 'ReturnStatement') {
            node.update(node.source().replace('return ', 'export default '));
        }
    });
}

/**
 *
 * @param {object} moduleFuncNode
 * @returns {string}
 */
function getModuleCode (moduleFuncNode) {

    updateReturnStatement(moduleFuncNode);

    var moduleCode = moduleFuncNode.body.source();

    // strip '{' and '}' from beginning and end
    moduleCode = moduleCode.substring(1);
    moduleCode = moduleCode.substring(0, moduleCode.length - 1);

    return moduleCode;
}

/**
 * Takes a CallExpression node and returns a array that contains the types of each argument.
 * @param {object} callExpression
 * @returns {array}
 */
function getArgumentsTypes (callExpression) {
    return callExpression.arguments.map(function (arg) {
        return arg.type;
    });
}

/**
 * Returns true if the node is a require() or define() CallExpression.
 * @param {object} node
 * @returns {boolean}
 */
function isRequireOrDefine (node) {
    return isRequire(node) || isDefine(node);
}

/**
 * Returns true if this node represents a require() call.
 * @param {object} node
 * @returns {boolean}
 */
function isRequire (node) {
    return node.type === 'CallExpression' && node.callee.name === 'require';
}

/**
 * Returns true if this node represents a define() call.
 * @param {object} node
 * @returns {boolean}
 */
function isDefine (node) {
    return node.type === 'CallExpression' && node.callee.name === 'define';
}

/**
 * Returns true if arr1 is the same as arr2.
 * @param {array} arr1
 * @param {array} arr2
 * @returns {boolean}
 */
function arrayEquals (arr1, arr2) {

    if (arr1.length !== arr2.length) {
        return false;
    }

    for (var i = 0; i < arr1.length; i++) {
        if (arr1[i] !== arr2[i]) {
            return false;
        }
    }

    return true;
}

/**
 * Returns true if node is a require() call where the module name is a literal.
 * @param {object} node
 * @returns {boolean}
 */
function isSyncRequire (node) {
    return isRequire(node) &&
           arrayEquals(getArgumentsTypes(node), ['Literal']);
}

/**
 * Returns true if a node is guaranteed to be called when the module is loaded.
 * @param  {object}  node Node to check
 * @return {boolean}
 */
function isAlwaysInvoked (node) {
    if (node) {
        switch (node.type) {
            // If node is in a function, it must be the `define` callback
            case 'FunctionExpression':
                return isDefine(node.parent);
                break;
            // Whitelist nodes that guarantee calling all of their children
            case 'CallExpression':
            case 'BinaryExpression':
            case 'ExpressionStatement':
            case 'VariableDeclaration':
            case 'VariableDeclarator':
            case 'BlockStatement':
                break;
            default:
                return false;
        }

        return isAlwaysInvoked(node.parent);
    }

    return false;
}

/**
 * Returns true if the require() call is statically analyzable.
 * @param  {object}  node Node to check
 * @return {boolean}
 */
function isStaticRequire (node) {
    var argTypes = getArgumentsTypes(node);
    return isAlwaysInvoked(node) && arrayEquals
}

/**
 * Returns true if node is a require() call where the module name is not a literal.
 * @param {object} node
 * @returns {boolean}
 */
function isRequireWithDynamicModuleName (node) {
    if (!isRequire(node)) {
        return false;
    }
    var argTypes = getArgumentsTypes(node);
    return argTypes.length === 1 && argTypes[argTypes.length - 1] !== 'Identifier';
}

/**
 * Adds all properties in source to target.
 * @param {object} target
 * @param {object} source
 */
function extend (target, source) {
    for (var key in source) {
        target[key] = source[key];
    }
}

var keys = Object.keys || function _keys(obj) {
    var ks = [];
    for (var k in obj) {
        if (obj.hasOwnProperty(k)) {
            ks.push(k);
        }
    }
    return ks;
};

/**
 * Returns true if the function includes a local `require` variable. This can
 * either be passed as 'require' in the dependency array, or can be passed as
 * an argument named `require` in the module function with no associated
 * dependency.
 * @param  {object}  func module function node
 * @param  {object}  deps dependency array node
 * @return {boolean}
 */
function hasLocalRequire (func, deps) {
    var depEls = deps ? deps.elements : [];
    return depEls.indexOf('require') > -1 || func.params.slice(depEls.length).some(function(param) {
        return param.name === 'require';
    });
}

/**
 * Returns true if this node represents a module definition using either a require or define.
 * @param {object} node
 * @returns {boolean}
 */
function isModuleDefinition (node) {

    if (!isRequireOrDefine(node)) {
        return false;
    }

    var argTypes = getArgumentsTypes(node);

    // eg. require(['a', 'b'])
    if (arrayEquals(argTypes, ['ArrayExpression'])) {
        return true;
    }

    // eg. require(['a', 'b'], function () {})
    if (arrayEquals(argTypes, ['ArrayExpression', 'FunctionExpression'])) {
        return true;
    }

    // eg. require(function () {}) or define(function () {})
    if (arrayEquals(argTypes, ['FunctionExpression'])) {
        return true;
    }
}

/**
 * Returns true if this node represents a call like require(['a', 'b']);
 * @param {object} node
 * @returns {boolean}
 */
function isRequireWithNoCallback (node) {
    return isRequire(node) && arrayEquals(getArgumentsTypes(node), ['ArrayExpression']);
}

/**
 * Returns true if node represents a named define eg. define('my-module', function () {})
 * @param {object} node
 * @returns {boolean}
 */
function isNamedDefine (node) {
    return isDefine(node) && getArgumentsTypes(node)[0] === 'Literal';
}

/**
 * Returns true if node represents a define call where the callback is an identifier eg. define(factoryFn);
 * @param {object} node
 * @returns {boolean}
 */
function isDefineUsingIdentifier (node) {
    if (!isDefine(node)) {
        return false;
    }
    var argTypes = getArgumentsTypes(node);
    return argTypes[argTypes.length - 1] === 'Identifier';
}

/**
 * Returns true if node represents a variable declarator
 * @param  {object}  node
 * @return {Boolean}
 */
function isVariableDeclarator (node) {
    return !!node && node.type === 'VariableDeclarator';
}

/**
 * Makes a new import name derived from the name of the module path.
 * @param {string[]} varNames    Names that have been used in file already
 * @param {string}   moduleName
 * @returns {string}
 */
function makeImportName (varNames, moduleName) {
    var name = '$__' + moduleName.replace(/-/g, '_').replace(/\//g, '_');
    return ensureUniqueImportName(varNames, name);
}

/**
 * Makes a new import name derived from the logical name of the module path.
 * @param  {string[]} varNames   Names that have been used in file already
 * @param  {string}   moduleName
 * @return {string}
 */
function makeLogicalImportName (varNames, moduleName) {
    var logicalId = moduleName.split('/').reverse()[0].split('.')[0];
    return ensureUniqueImportName(varNames, logicalId);
}

/**
 * Ensures a variable name is unique. Modifies the list of var names used in
 * the file.
 * @param  {string[]} varNames     Variable names used in file
 * @param  {string}   proposedName
 * @return {string}
 */
function ensureUniqueImportName (varNames, proposedName) {
    var name = proposedName;
    var i = 1;

    while (varNames.indexOf(name) >= 0) {
        name = proposedName + (i++);
    }

    varNames.push(name);
    return name;
}
