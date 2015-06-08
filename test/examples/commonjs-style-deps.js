define(function (require) {

    var varNameForA = require('some/path/to/a');
    var varNameForB = require('some/path/to/b'),
        foo = "foo",
        varNameForC = require('some/path/to/c'),
        bar = "bar";

    // do something with dep A
    varNameForA();

    // do something with dep B
    varNameForB();

    // do something with dep C
    varNameForC();

});
