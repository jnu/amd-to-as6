var falafel = require('falafel');
var beautify = require('js-beautify').js_beautify;

module.exports = convert;

/**
 * Converts some code from AMD to ES6
 * @param {string} source
 * @returns {string}
 */
function convert (source) {

    var dependenciesMap = {};
    var syncRequires = [];
    var requiresWithSideEffects = [];
    var mainCallExpression = null;

    var result = falafel(source, function (node) {

        if (isNamedDefine(node)) {
            throw new Error('Found a named define() - this is not supported.');
        }

        if (isModuleDefinition(node)) {

            if (mainCallExpression) {
                throw new Error('Found multiple module definitions in file.');
            }

            mainCallExpression = node;
        }

        else if (isSyncRequire(node)) {
            syncRequires.push(node);
        }

        else if (isRequireWithSideEffects(node)) {
            requiresWithSideEffects.push(node);
        }

    });

    // no module definition found - return source untouched
    if (!mainCallExpression) {
        return source;
    }

    var moduleDeps = mainCallExpression.arguments.length > 1 ? mainCallExpression.arguments[0] : null;
    var moduleFunc = mainCallExpression.arguments[mainCallExpression.arguments.length > 1 ? 1 : 0];
    var hasDeps = moduleDeps && moduleDeps.elements.length > 0;

    if (hasDeps) {

        var modulePaths = moduleDeps.elements.map(function (element) {
            return element.value;
        });

        var importNames = moduleFunc.params.map(function (param) {
            return param.name;
        });

        extend(dependenciesMap, modulePaths.reduce(function (obj, path, index) {
            obj[path] = importNames[index] || null;
            return obj;
        }, {}));
    }

    syncRequires.forEach(function (node) {
        var moduleName = node.arguments[0].value;

        // if no import name assigned then create one
        if (!dependenciesMap[moduleName]) {
            dependenciesMap[moduleName] = makeImportName(moduleName);
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
        node.parent.update('');
    });

    // start with import statements
    var moduleCode = getImportStatements(dependenciesMap);

    // add modules code
    moduleCode += getModuleCode(moduleFunc);

    // fix indentation
    moduleCode = beautify(moduleCode);

    // jsbeautify doesn't understand es6 module syntax yet
    moduleCode = moduleCode.replace(/export[\s\S]default[\s\S]/, 'export default ');

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

        if (!dependencies[key]) {
            statements.push('import \'' + key + '\';');
        }
        else {
            statements.push('import ' + dependencies[key] + ' from \'' + key + '\';');
        }
    }

    return statements.join('\n');
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
 *
 * @param {object} node
 * @returns {boolean}
 */
function isSyncRequire (node) {
    return isRequire(node) &&
           arrayEquals(getArgumentsTypes(node), ['Literal']);
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
function isRequireWithSideEffects (node) {
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
 * Makes a new import name derived from the name of the module path.
 * @param {string} moduleName
 * @returns {string}
 */
function makeImportName (moduleName) {
    return '$__' + moduleName.replace(/-/g, '_').replace(/\//g, '_');
}