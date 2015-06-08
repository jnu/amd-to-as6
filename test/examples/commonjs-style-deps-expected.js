import varNameForA from 'some/path/to/a';
import varNameForB from 'some/path/to/b';
import varNameForC from 'some/path/to/c';

var foo = 'foo',
    bar = 'bar';
// do something with dep A
varNameForA();

// do something with dep B
varNameForB();

// do something with dep C
varNameForC();
