import zlib from 'zlib';
import { Readable } from 'stream';

import Koa from 'koa';
import mount from 'koa-mount';
import session from 'koa-session';
import parseBody from 'co-body';
import getRawBody from 'raw-body';
import request from 'supertest';

import type { ASTVisitor, ValidationContext } from 'graphql';
import sinon from 'sinon';
import multer from 'multer';
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  Source,
  GraphQLError,
  GraphQLString,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  parse,
  execute,
  validate,
  buildSchema,
} from 'graphql';

import graphqlHTTP from '../index';

import multerWrapper from './helpers/koa-multer';

declare module 'koa' {
  interface Request {
    body?: any;
    rawBody: string;
  }
}

type MulterFile = {
  /** Name of the form field associated with this file. */
  fieldname: string;
  /** Name of the file on the uploader's computer. */
  originalname: string;
  /**
   * Value of the `Content-Transfer-Encoding` header for this file.
   * @deprecated since July 2015
   * @see RFC 7578, Section 4.7
   */
  encoding: string;
  /** Value of the `Content-Type` header for this file. */
  mimetype: string;
  /** Size of the file in bytes. */
  size: number;
  /**
   * A readable stream of this file. Only available to the `_handleFile`
   * callback for custom `StorageEngine`s.
   */
  stream: Readable;
  /** `DiskStorage` only: Directory to which this file has been uploaded. */
  destination: string;
  /** `DiskStorage` only: Name of this file within `destination`. */
  filename: string;
  /** `DiskStorage` only: Full path to the uploaded file. */
  path: string;
  /** `MemoryStorage` only: A Buffer containing the entire file. */
  buffer: Buffer;
};

declare module 'http' {
  interface IncomingMessage {
    file?: MulterFile | undefined;
    /**
     * Array or dictionary of `Multer.File` object populated by `array()`,
     * `fields()`, and `any()` middleware.
     */
    files?:
      | {
          [fieldname: string]: Array<MulterFile>;
        }
      | Array<MulterFile>
      | undefined;
  }
}

const QueryRootType = new GraphQLObjectType({
  name: 'QueryRoot',
  fields: {
    test: {
      type: GraphQLString,
      args: {
        who: { type: GraphQLString },
      },
      resolve: (_root, args: { who?: string }) =>
        'Hello ' + (args.who ?? 'World'),
    },
    thrower: {
      type: GraphQLString,
      resolve: () => {
        throw new Error('Throws!');
      },
    },
  },
});

const TestSchema = new GraphQLSchema({
  query: QueryRootType,
  mutation: new GraphQLObjectType({
    name: 'MutationRoot',
    fields: {
      writeTest: {
        type: QueryRootType,
        resolve: () => ({}),
      },
    },
  }),
});

function stringifyURLParams(urlParams?: { [param: string]: string }): string {
  return new URLSearchParams(urlParams).toString();
}

function urlString(urlParams?: { [param: string]: string }): string {
  let string = '/graphql';
  if (urlParams) {
    string += '?' + stringifyURLParams(urlParams);
  }
  return string;
}

function server<StateT = Koa.DefaultState, ContextT = Koa.DefaultContext>() {
  const app = new Koa<StateT, ContextT>();

  /* istanbul ignore next Error handler added only for debugging failed tests */
  app.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.warn('App encountered an error:', error);
  });

  return app;
}

describe('GraphQL-HTTP tests', () => {
  describe('GET functionality', () => {
    it('allows GET with query param', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{test}',
        }),
      );

      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('allows GET with variable values', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: 'query helloWho($who: String){ test(who: $who) }',
          variables: JSON.stringify({ who: 'Dolly' }),
        }),
      );

      expect(response.text).to.equal('{"data":{"test":"Hello Dolly"}}');
    });

    it('allows GET with operation name', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: `
            query helloYou { test(who: "You"), ...shared }
            query helloWorld { test(who: "World"), ...shared }
            query helloDolly { test(who: "Dolly"), ...shared }
            fragment shared on QueryRoot {
              shared: test(who: "Everyone")
            }
          `,
          operationName: 'helloWorld',
        }),
      );

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
          shared: 'Hello Everyone',
        },
      });
    });

    it('Reports validation errors', async () => {
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const response = await request(app.listen()).get(
        urlString({
          query: '{ test, unknownOne, unknownTwo }',
        }),
      );

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message: 'Cannot query field "unknownOne" on type "QueryRoot".',
            locations: [{ line: 1, column: 9 }],
          },
          {
            message: 'Cannot query field "unknownTwo" on type "QueryRoot".',
            locations: [{ line: 1, column: 21 }],
          },
        ],
      });
    });

    it('Errors when missing operation name', async () => {
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const response = await request(app.listen()).get(
        urlString({
          query: `
            query TestQuery { test }
            mutation TestMutation { writeTest { test } }
          `,
        }),
      );

      expect(response.status).to.equal(500);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message:
              'Must provide operation name if query contains multiple operations.',
          },
        ],
      });
    });

    it('Errors when sending a mutation via GET', async () => {
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const response = await request(app.listen()).get(
        urlString({
          query: 'mutation TestMutation { writeTest { test } }',
        }),
      );

      expect(response.status).to.equal(405);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message:
              'Can only perform a mutation operation from a POST request.',
          },
        ],
      });
    });

    it('Errors when selecting a mutation within a GET', async () => {
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const response = await request(app.listen()).get(
        urlString({
          operationName: 'TestMutation',
          query: `
            query TestQuery { test }
            mutation TestMutation { writeTest { test } }
          `,
        }),
      );

      expect(response.status).to.equal(405);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message:
              'Can only perform a mutation operation from a POST request.',
          },
        ],
      });
    });

    it('Allows a mutation to exist within a GET', async () => {
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const response = await request(app.listen()).get(
        urlString({
          operationName: 'TestQuery',
          query: `
            mutation TestMutation { writeTest { test } }
            query TestQuery { test }
          `,
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
        },
      });
    });

    it('Allows async resolvers', async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            foo: {
              type: GraphQLString,
              resolve: () => Promise.resolve('bar'),
            },
          },
        }),
      });
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema })));

      const response = await request(app.listen()).get(
        urlString({
          query: '{ foo }',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: { foo: 'bar' },
      });
    });

    it('Allows passing in a context', async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            test: {
              type: GraphQLString,
              resolve: (_obj, _args, context) => context,
            },
          },
        }),
      });
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema,
            context: 'testValue',
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{ test }',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'testValue',
        },
      });
    });

    it('Allows passing in a fieldResolver', async () => {
      const schema = buildSchema(`
        type Query {
          test: String
        }
      `);
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema,
            fieldResolver: () => 'fieldResolver data',
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{ test }',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'fieldResolver data',
        },
      });
    });

    it('Allows passing in a typeResolver', async () => {
      const schema = buildSchema(`
        type Foo {
          foo: String
        }
        type Bar {
          bar: String
        }
        union UnionType = Foo | Bar
        type Query {
          test: UnionType
        }
      `);
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema,
            rootValue: { test: {} },
            typeResolver: () => 'Bar',
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{ test { __typename } }',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: { __typename: 'Bar' },
        },
      });
    });

    it('Uses ctx as context by default', async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            test: {
              type: GraphQLString,
              resolve: (_obj, _args, context) => context.foo,
            },
          },
        }),
      });
      const app = server();

      // Middleware that adds ctx.foo to every request
      app.use((ctx, next) => {
        ctx.foo = 'bar';
        return next();
      });

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{ test }',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'bar',
        },
      });
    });

    it('Allows returning an options Promise', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() =>
            Promise.resolve({
              schema: TestSchema,
            }),
          ),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{test}',
        }),
      );

      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('Catches errors thrown from options function', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => {
            throw new Error('I did something wrong');
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{test}',
        }),
      );

      expect(response.status).to.equal(500);
      expect(response.text).to.equal(
        '{"errors":[{"message":"I did something wrong"}]}',
      );
    });
  });

  describe('POST functionality', () => {
    it('allows POST with JSON encoding', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .send({ query: '{test}' });

      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('Allows sending a mutation via POST', async () => {
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const response = await request(app.listen())
        .post(urlString())
        .send({ query: 'mutation TestMutation { writeTest { test } }' });

      expect(response.status).to.equal(200);
      expect(response.text).to.equal(
        '{"data":{"writeTest":{"test":"Hello World"}}}',
      );
    });

    it('allows POST with url encoding', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .send(stringifyURLParams({ query: '{test}' }));

      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('supports POST JSON query with string variables', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .send({
          query: 'query helloWho($who: String){ test(who: $who) }',
          variables: JSON.stringify({ who: 'Dolly' }),
        });

      expect(response.text).to.equal('{"data":{"test":"Hello Dolly"}}');
    });

    it('supports POST JSON query with JSON variables', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .send({
          query: 'query helloWho($who: String){ test(who: $who) }',
          variables: { who: 'Dolly' },
        });

      expect(response.text).to.equal('{"data":{"test":"Hello Dolly"}}');
    });

    it('supports POST url encoded query with string variables', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .send(
          stringifyURLParams({
            query: 'query helloWho($who: String){ test(who: $who) }',
            variables: JSON.stringify({ who: 'Dolly' }),
          }),
        );

      expect(response.text).to.equal('{"data":{"test":"Hello Dolly"}}');
    });

    it('supports POST JSON query with GET variable values', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(
          urlString({
            variables: JSON.stringify({ who: 'Dolly' }),
          }),
        )
        .send({ query: 'query helloWho($who: String){ test(who: $who) }' });

      expect(response.text).to.equal('{"data":{"test":"Hello Dolly"}}');
    });

    it('supports POST url encoded query with GET variable values', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(
          urlString({
            variables: JSON.stringify({ who: 'Dolly' }),
          }),
        )
        .send(
          stringifyURLParams({
            query: 'query helloWho($who: String){ test(who: $who) }',
          }),
        );

      expect(response.text).to.equal('{"data":{"test":"Hello Dolly"}}');
    });

    it('supports POST raw text query with GET variable values', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(
          urlString({
            variables: JSON.stringify({ who: 'Dolly' }),
          }),
        )
        .set('Content-Type', 'application/graphql')
        .send('query helloWho($who: String){ test(who: $who) }');

      expect(response.text).to.equal('{"data":{"test":"Hello Dolly"}}');
    });

    it('allows POST with operation name', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .send({
          query: `
            query helloYou { test(who: "You"), ...shared }
            query helloWorld { test(who: "World"), ...shared }
            query helloDolly { test(who: "Dolly"), ...shared }
            fragment shared on QueryRoot {
              shared: test(who: "Everyone")
            }
          `,
          operationName: 'helloWorld',
        });

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
          shared: 'Hello Everyone',
        },
      });
    });

    it('allows POST with GET operation name', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(
          urlString({
            operationName: 'helloWorld',
          }),
        )
        .set('Content-Type', 'application/graphql').send(`
          query helloYou { test(who: "You"), ...shared }
          query helloWorld { test(who: "World"), ...shared }
          query helloDolly { test(who: "Dolly"), ...shared }
          fragment shared on QueryRoot {
            shared: test(who: "Everyone")
          }
        `);

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
          shared: 'Hello Everyone',
        },
      });
    });

    it('allows other UTF charsets', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const req = request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/graphql; charset=utf-16');
      req.write(Buffer.from('{ test(who: "World") }', 'utf16le'));
      const response = await req;

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
        },
      });
    });

    it('allows gzipped POST bodies', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const req = request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip');

      req.write(zlib.gzipSync('{ "query": "{ test }" }'));

      const response = await req;

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
        },
      });
    });

    it('allows deflated POST bodies', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const req = request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'deflate');

      req.write(zlib.deflateSync('{ "query": "{ test }" }'));

      const response = await req;

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
        },
      });
    });

    // should replace multer with koa middleware
    it('allows for pre-parsed POST bodies', async () => {
      // Note: this is not the only way to handle file uploads with GraphQL,
      // but it is terse and illustrative of using koa-graphql and multer
      // together.

      // A simple schema which includes a mutation.
      const UploadedFileType = new GraphQLObjectType({
        name: 'UploadedFile',
        fields: {
          originalname: { type: GraphQLString },
          mimetype: { type: GraphQLString },
        },
      });

      const TestMutationSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'QueryRoot',
          fields: {
            test: { type: GraphQLString },
          },
        }),
        mutation: new GraphQLObjectType({
          name: 'MutationRoot',
          fields: {
            uploadFile: {
              type: UploadedFileType,
              resolve(rootValue) {
                // For this test demo, we're just returning the uploaded
                // file directly, but presumably you might return a Promise
                // to go store the file somewhere first.
                return rootValue.request.file;
              },
            },
          },
        }),
      });

      const app = server();

      // Multer provides multipart form data parsing.
      const storage = multer.memoryStorage();
      app.use(mount(urlString(), multerWrapper({ storage }).single('file')));

      // Providing the request as part of `rootValue` allows it to
      // be accessible from within Schema resolve functions.
      app.use(
        mount(
          urlString(),
          graphqlHTTP((_req, ctx) => {
            expect(ctx.req.file?.originalname).to.equal('test.txt');
            return {
              schema: TestMutationSchema,
              rootValue: { request: ctx.req },
            };
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .field(
          'query',
          `mutation TestMutation {
          uploadFile { originalname, mimetype }
        }`,
        )
        .attach('file', Buffer.from('test'), 'test.txt');

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          uploadFile: {
            originalname: 'test.txt',
            mimetype: 'text/plain',
          },
        },
      });
    });

    it('allows for pre-parsed POST using application/graphql', async () => {
      const app = server();
      app.use(async (ctx, next) => {
        if (typeof ctx.is('application/graphql') === 'string') {
          // eslint-disable-next-line require-atomic-updates
          ctx.request.body = await parseBody.text(ctx);
        }
        return next();
      });

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const req = request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/graphql');
      req.write(Buffer.from('{ test(who: "World") }'));
      const response = await req;

      expect(JSON.parse(response.text)).to.deep.equal({
        data: {
          test: 'Hello World',
        },
      });
    });

    it('does not accept unknown pre-parsed POST string', async () => {
      const app = server();
      app.use(async (ctx, next) => {
        if (typeof ctx.is('*/*') === 'string') {
          // eslint-disable-next-line require-atomic-updates
          ctx.request.body = await parseBody.text(ctx);
        }
        return next();
      });

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const req = request(app.listen()).post(urlString());
      req.write(Buffer.from('{ test(who: "World") }'));
      const response = await req;

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Must provide query string.' }],
      });
    });

    it('does not accept unknown pre-parsed POST raw Buffer', async () => {
      const app = server();
      app.use(async (ctx, next) => {
        if (typeof ctx.is('*/*') === 'string') {
          const req = ctx.req;
          // eslint-disable-next-line require-atomic-updates
          ctx.request.body = await getRawBody(req, {
            length: req.headers['content-length'],
            limit: '1mb',
            encoding: null,
          });
        }
        return next();
      });

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const req = request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/graphql');
      req.write(Buffer.from('{ test(who: "World") }'));
      const response = await req;

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Must provide query string.' }],
      });
    });
  });

  describe('Pretty printing', () => {
    it('supports pretty printing', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            pretty: true,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{test}',
        }),
      );

      expect(response.text).to.equal(
        [
          // Pretty printed JSON
          '{',
          '  "data": {',
          '    "test": "Hello World"',
          '  }',
          '}',
        ].join('\n'),
      );
    });

    it('supports pretty printing configured by request', async () => {
      const app = server();
      let pretty: boolean | undefined;

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => ({
            schema: TestSchema,
            pretty,
          })),
        ),
      );

      pretty = undefined;
      const defaultResponse = await request(app.listen()).get(
        urlString({
          query: '{test}',
        }),
      );

      expect(defaultResponse.text).to.equal('{"data":{"test":"Hello World"}}');

      pretty = true;
      const prettyResponse = await request(app.listen()).get(
        urlString({
          query: '{test}',
          pretty: '1',
        }),
      );

      expect(prettyResponse.text).to.equal(
        [
          // Pretty printed JSON
          '{',
          '  "data": {',
          '    "test": "Hello World"',
          '  }',
          '}',
        ].join('\n'),
      );

      pretty = false;
      const unprettyResponse = await request(app.listen()).get(
        urlString({
          query: '{test}',
          pretty: '0',
        }),
      );

      expect(unprettyResponse.text).to.equal('{"data":{"test":"Hello World"}}');
    });
  });

  it('will send request, response and context when using thunk', async () => {
    const app = server();

    let seenRequest;
    let seenResponse;
    let seenContext;

    app.use(
      mount(
        urlString(),
        graphqlHTTP((reqest, response, context) => {
          seenRequest = reqest;
          seenResponse = response;
          seenContext = context;
          return { schema: TestSchema };
        }),
      ),
    );

    await request(app.listen()).get(urlString({ query: '{test}' }));

    expect(seenRequest).to.not.equal(undefined);
    expect(seenResponse).to.not.equal(undefined);
    expect(seenContext).to.not.equal(undefined);
  });

  describe('Error handling functionality', () => {
    it('handles field errors caught by GraphQL', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{thrower}',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: { thrower: null },
        errors: [
          {
            message: 'Throws!',
            locations: [{ line: 1, column: 2 }],
            path: ['thrower'],
          },
        ],
      });
    });

    it('handles query errors from non-null top field errors', async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            test: {
              type: new GraphQLNonNull(GraphQLString),
              resolve() {
                throw new Error('Throws!');
              },
            },
          },
        }),
      });
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{ test }',
        }),
      );

      expect(response.status).to.equal(500);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: null,
        errors: [
          {
            message: 'Throws!',
            locations: [{ line: 1, column: 3 }],
            path: ['test'],
          },
        ],
      });
    });

    it('allows for custom error formatting to sanitize', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            customFormatErrorFn(error) {
              return { message: 'Custom error format: ' + error.message };
            },
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{thrower}',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: { thrower: null },
        errors: [
          {
            message: 'Custom error format: Throws!',
          },
        ],
      });
    });

    it('allows for custom error formatting to elaborate', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            customFormatErrorFn(error) {
              return {
                message: error.message,
                locations: error.locations,
                stack: 'Stack trace',
              };
            },
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{thrower}',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: { thrower: null },
        errors: [
          {
            message: 'Throws!',
            locations: [{ line: 1, column: 2 }],
            stack: 'Stack trace',
          },
        ],
      });
    });

    it('handles syntax errors caught by GraphQL', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: 'syntaxerror',
        }),
      );

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message: 'Syntax Error: Unexpected Name "syntaxerror".',
            locations: [{ line: 1, column: 1 }],
          },
        ],
      });
    });

    it('handles errors caused by a lack of query', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).get(urlString());

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Must provide query string.' }],
      });
    });

    it('handles invalid JSON bodies', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/json')
        .send('[]');

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'POST body sent invalid JSON.' }],
      });
    });

    it('handles incomplete JSON bodies', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/json')
        .send('{"query":');

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'POST body sent invalid JSON.' }],
      });
    });

    it('handles plain POST text', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(
          urlString({
            variables: JSON.stringify({ who: 'Dolly' }),
          }),
        )
        .set('Content-Type', 'text/plain')
        .send('query helloWho($who: String){ test(who: $who) }');

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Must provide query string.' }],
      });
    });

    it('handles unsupported charset', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/graphql; charset=ascii')
        .send('{ test(who: "World") }');

      expect(response.status).to.equal(415);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Unsupported charset "ASCII".' }],
      });
    });

    it('handles unsupported utf charset', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/graphql; charset=utf-53')
        .send('{ test(who: "World") }');

      expect(response.status).to.equal(415);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Unsupported charset "UTF-53".' }],
      });
    });

    it('handles unknown encoding', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .set('Content-Encoding', 'garbage')
        .send('!@#$%^*(&^$%#@');

      expect(response.status).to.equal(415);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Unsupported content-encoding "garbage".' }],
      });
    });

    it('handles invalid body', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => ({
            schema: TestSchema,
          })),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .set('Content-Type', 'application/json')
        .send(`{ "query": "{ ${new Array(102400).fill('test').join('')} }" }`);

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Invalid body: request entity too large.' }],
      });
    });

    it('handles poorly formed variables', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          variables: 'who:You',
          query: 'query helloWho($who: String){ test(who: $who) }',
        }),
      );

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'Variables are invalid JSON.' }],
      });
    });

    it('`formatError` is deprecated', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            formatError(error) {
              return { message: 'Custom error format: ' + error.message };
            },
          }),
        ),
      );

      const spy = sinon.spy(console, 'warn');

      const response = await request(app.listen()).get(
        urlString({
          variables: 'who:You',
          query: 'query helloWho($who: String){ test(who: $who) }',
        }),
      );

      expect(
        spy.calledWith(
          '`formatError` is deprecated and replaced by `customFormatErrorFn`. It will be removed in version 1.0.0.',
        ),
      );
      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message: 'Custom error format: Variables are invalid JSON.',
          },
        ],
      });

      spy.restore();
    });

    it('allows for custom error formatting of poorly formed requests', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            customFormatErrorFn(error) {
              return { message: 'Custom error format: ' + error.message };
            },
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          variables: 'who:You',
          query: 'query helloWho($who: String){ test(who: $who) }',
        }),
      );

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message: 'Custom error format: Variables are invalid JSON.',
          },
        ],
      });
    });

    it('allows disabling prettifying poorly formed requests', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            pretty: false,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          variables: 'who:You',
          query: 'query helloWho($who: String){ test(who: $who) }',
        }),
      );

      expect(response.status).to.equal(400);
      expect(response.text).to.equal(
        '{"errors":[{"message":"Variables are invalid JSON."}]}',
      );
    });

    it('handles invalid variables', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen())
        .post(urlString())
        .send({
          query: 'query helloWho($who: String){ test(who: $who) }',
          variables: { who: ['Dolly', 'Jonty'] },
        });

      expect(response.status).to.equal(500);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            locations: [{ column: 16, line: 1 }],
            message:
              'Variable "$who" got invalid value ["Dolly", "Jonty"]; String cannot represent a non string value: ["Dolly", "Jonty"]',
          },
        ],
      });
    });

    it('handles unsupported HTTP methods', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
          }),
        ),
      );

      const response = await request(app.listen()).put(
        urlString({ query: '{test}' }),
      );

      expect(response.status).to.equal(405);
      expect(response.get('allow')).to.equal('GET, POST');
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [{ message: 'GraphQL only supports GET and POST requests.' }],
      });
    });
  });

  describe('Built-in GraphiQL support', () => {
    it('does not renders GraphiQL if no opt-in', async () => {
      const app = server();

      app.use(mount(urlString(), graphqlHTTP({ schema: TestSchema })));

      const response = await request(app.listen())
        .get(urlString({ query: '{test}' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('application/json');
      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('presents GraphiQL when accepting HTML', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include('graphiql.min.js');
    });

    it('contains a default query within GraphiQL', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: { defaultQuery: 'query testDefaultQuery { hello }' },
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString())
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include(
        'defaultQuery: "query testDefaultQuery { hello }"',
      );
    });

    it('contains a pre-run response within GraphiQL', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include(
        'response: ' +
          JSON.stringify(
            JSON.stringify({ data: { test: 'Hello World' } }, null, 2),
          ),
      );
    });

    it('contains a pre-run operation name within GraphiQL', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(
          urlString({
            query: 'query A{a:test} query B{b:test}',
            operationName: 'B',
          }),
        )
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include(
        'response: ' +
          JSON.stringify(
            JSON.stringify({ data: { b: 'Hello World' } }, null, 2),
          ),
      );
      expect(response.text).to.include('operationName: "B"');
    });

    it('escapes HTML in queries within GraphiQL', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '</script><script>alert(1)</script>' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(400);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.not.include(
        '</script><script>alert(1)</script>',
      );
    });

    it('escapes HTML in variables within GraphiQL', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(
          urlString({
            query: 'query helloWho($who: String) { test(who: $who) }',
            variables: JSON.stringify({
              who: '</script><script>alert(1)</script>',
            }),
          }),
        )
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.not.include(
        '</script><script>alert(1)</script>',
      );
    });

    it('GraphiQL renders provided variables', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(
          urlString({
            query: 'query helloWho($who: String) { test(who: $who) }',
            variables: JSON.stringify({ who: 'Dolly' }),
          }),
        )
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include(
        'variables: ' +
          JSON.stringify(JSON.stringify({ who: 'Dolly' }, null, 2)),
      );
    });

    it('GraphiQL accepts an empty query', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString())
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include('response: undefined');
    });

    it('GraphiQL accepts a mutation query - does not execute it', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(
          urlString({
            query: 'mutation TestMutation { writeTest { test } }',
          }),
        )
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include(
        'query: "mutation TestMutation { writeTest { test } }"',
      );
      expect(response.text).to.include('response: undefined');
    });

    it('returns HTML if preferred', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}' }))
        .set('Accept', 'text/html,application/json');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('text/html');
      expect(response.text).to.include('{test}');
      expect(response.text).to.include('graphiql.min.js');
    });

    it('returns JSON if preferred', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}' }))
        .set('Accept', 'application/json,text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('application/json');
      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('prefers JSON if unknown accept', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}' }))
        .set('Accept', 'unknown');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('application/json');
      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('prefers JSON if explicitly requested raw response', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            graphiql: true,
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}', raw: '' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('application/json');
      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });
  });

  describe('Custom validate function', () => {
    it('returns data', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            customValidateFn(schema, documentAST, validationRules) {
              return validate(schema, documentAST, validationRules);
            },
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}', raw: '' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });

    it('returns validation errors', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            customValidateFn(schema, documentAST, validationRules) {
              const errors = validate(schema, documentAST, validationRules);

              return [new GraphQLError(`custom error ${errors.length}`)];
            },
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{thrower}',
        }),
      );

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message: 'custom error 0',
          },
        ],
      });
    });
  });

  describe('Custom validation rules', () => {
    const AlwaysInvalidRule = function (
      context: ValidationContext,
    ): ASTVisitor {
      return {
        Document() {
          context.reportError(
            new GraphQLError('AlwaysInvalidRule was really invalid!'),
          );
        },
      };
    };

    it('Do not execute a query if it do not pass the custom validation.', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            validationRules: [AlwaysInvalidRule],
            pretty: true,
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{thrower}',
        }),
      );

      expect(response.status).to.equal(400);
      expect(JSON.parse(response.text)).to.deep.equal({
        errors: [
          {
            message: 'AlwaysInvalidRule was really invalid!',
          },
        ],
      });
    });
  });

  describe('Session support', () => {
    it('supports koa-session', async () => {
      const SessionAwareGraphQLSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'MyType',
          fields: {
            myField: {
              type: GraphQLString,
              resolve(_parentValue, _, sess) {
                return sess.id;
              },
            },
          },
        }),
      });
      const app = server();
      app.keys = ['some secret hurr'];
      app.use(session(app));
      app.use((ctx, next) => {
        if (ctx.session !== null) {
          ctx.session.id = 'me';
        }
        return next();
      });

      app.use(
        mount(
          '/graphql',
          graphqlHTTP((_req, _res, ctx) => ({
            schema: SessionAwareGraphQLSchema,
            context: ctx.session,
          })),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{myField}',
        }),
      );

      expect(response.text).to.equal('{"data":{"myField":"me"}}');
    });
  });

  describe('Custom execute', () => {
    it('allow to replace default execute', async () => {
      const app = server();

      let seenExecuteArgs;

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => ({
            schema: TestSchema,
            async customExecuteFn(args) {
              seenExecuteArgs = args;
              const result = await Promise.resolve(execute(args));
              return {
                ...result,
                data: {
                  ...result.data,
                  test2: 'Modification',
                },
              };
            },
          })),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}', raw: '' }))
        .set('Accept', 'text/html');

      expect(response.text).to.equal(
        '{"data":{"test":"Hello World","test2":"Modification"}}',
      );
      expect(seenExecuteArgs).to.not.equal(null);
    });

    it('catches errors thrown from custom execute function', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => ({
            schema: TestSchema,
            customExecuteFn() {
              throw new Error('I did something wrong');
            },
          })),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}', raw: '' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(400);
      expect(response.text).to.equal(
        '{"errors":[{"message":"I did something wrong"}]}',
      );
    });
  });

  describe('Custom parse function', () => {
    it('can replace default parse functionality', async () => {
      const app = server();

      let seenParseArgs;

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => ({
            schema: TestSchema,
            customParseFn(args) {
              seenParseArgs = args;
              return parse(new Source('{test}', 'Custom parse function'));
            },
          })),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({ query: '----' }),
      );

      expect(response.status).to.equal(200);
      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
      expect(seenParseArgs).property('body', '----');
    });

    it('can throw errors', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => ({
            schema: TestSchema,
            customParseFn() {
              throw new GraphQLError('my custom parse error');
            },
          })),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({ query: '----' }),
      );

      expect(response.status).to.equal(400);
      expect(response.text).to.equal(
        '{"errors":[{"message":"my custom parse error"}]}',
      );
    });
  });

  describe('Custom result extensions', () => {
    it('allows for adding extensions', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP(() => ({
            schema: TestSchema,
            context: { foo: 'bar' },
            extensions({ context }) {
              return { contextValue: JSON.stringify(context) };
            },
          })),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}', raw: '' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('application/json');
      expect(response.text).to.equal(
        '{"data":{"test":"Hello World"},"extensions":{"contextValue":"{\\"foo\\":\\"bar\\"}"}}',
      );
    });

    it('extensions have access to initial GraphQL result', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            customFormatErrorFn: () => null,
            extensions({ result }) {
              return { preservedResult: { ...result } };
            },
          }),
        ),
      );

      const response = await request(app.listen()).get(
        urlString({
          query: '{thrower}',
        }),
      );

      expect(response.status).to.equal(200);
      expect(JSON.parse(response.text)).to.deep.equal({
        data: { thrower: null },
        errors: [null],
        extensions: {
          preservedResult: {
            data: { thrower: null },
            errors: [
              {
                message: 'Throws!',
                locations: [{ line: 1, column: 2 }],
                path: ['thrower'],
              },
            ],
          },
        },
      });
    });

    it('extension function may be async', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          graphqlHTTP({
            schema: TestSchema,
            extensions() {
              // Note: you can await arbitrary things here!
              return Promise.resolve({ eventually: 42 });
            },
          }),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}', raw: '' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('application/json');
      expect(response.text).to.equal(
        '{"data":{"test":"Hello World"},"extensions":{"eventually":42}}',
      );
    });

    it('does nothing if extensions function does not return an object', async () => {
      const app = server();

      app.use(
        mount(
          urlString(),
          // @ts-expect-error
          graphqlHTTP(() => ({
            schema: TestSchema,
            context: { foo: 'bar' },
            extensions({ context }) {
              return () => ({ contextValue: JSON.stringify(context) });
            },
          })),
        ),
      );

      const response = await request(app.listen())
        .get(urlString({ query: '{test}', raw: '' }))
        .set('Accept', 'text/html');

      expect(response.status).to.equal(200);
      expect(response.type).to.equal('application/json');
      expect(response.text).to.equal('{"data":{"test":"Hello World"}}');
    });
  });
});
