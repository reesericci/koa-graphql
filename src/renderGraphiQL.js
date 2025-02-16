// @flow strict

import type { ExecutionResult } from 'graphql';

type EditorThemeParam =
  | {|
      name: string,
      url: string,
    |}
  | string;

type GraphiQLData = {|
  query: ?string,
  variables: ?{ [param: string]: mixed },
  operationName: ?string,
  result?: ?ExecutionResult,
  options: ?GraphiQLOptions,
|};

export type GraphiQLOptions = {|
  /**
   * An optional GraphQL string to use when no query is provided and no stored
   * query exists from a previous session.  If undefined is provided, GraphiQL
   * will use its own default query.
   */
  defaultQuery?: ?string,

  /**
   * By passing an object you may change the theme of GraphiQL.
   */
  editorTheme?: EditorThemeParam,
|};

type EditorTheme =
  | {|
      name: string,
      link: string,
    |}
  | {||};

// Current latest version of codeMirror.
const CODE_MIRROR_VERSION = '5.53.2';

// Ensures string values are safe to be used within a <script> tag.
function safeSerialize(data: ?string): string {
  return data != null
    ? JSON.stringify(data).replace(/\//g, '\\/')
    : 'undefined';
}

// Implemented as Babel transformation, see ../resources/load-staticly-from-npm.js
declare function loadFileStaticlyFromNPM(npmPath: string): string;

function getEditorThemeParams(editorTheme: EditorThemeParam): EditorTheme {
  if (!editorTheme) {
    return {};
  }
  if (typeof editorTheme === 'string') {
    return {
      name: editorTheme,
      link: `<link href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/${CODE_MIRROR_VERSION}/theme/${editorTheme}.css" rel="stylesheet" />`,
    };
  }
  if (
    typeof editorTheme === 'object' &&
    editorTheme.name &&
    typeof editorTheme.name === 'string' &&
    editorTheme.url &&
    typeof editorTheme.url === 'string'
  ) {
    return {
      link: `<link href="${editorTheme.url}" rel="stylesheet" />`,
      name: editorTheme.name,
    };
  }
  throw Error(
    'invalid parameter "editorTheme": should be undefined/null, string or ' +
      `{name: string, url: string} but provided is "${editorTheme}"`,
  );
}

/**
 * When express-graphql receives a request which does not Accept JSON, but does
 * Accept HTML, it may present GraphiQL, the in-browser GraphQL explorer IDE.
 *
 * When shown, it will be pre-populated with the result of having executed the
 * requested query.
 */
export function renderGraphiQL(data: GraphiQLData): string {
  const queryString = data.query;
  const variablesString =
    data.variables != null ? JSON.stringify(data.variables, null, 2) : null;
  const resultString =
    data.result != null ? JSON.stringify(data.result, null, 2) : null;
  const operationName = data.operationName;
  const defaultQuery = data.options?.defaultQuery;
  const editorTheme = getEditorThemeParams(data.options.editorTheme);

  return `<!--
The request to this GraphQL server provided the header "Accept: text/html"
and as a result has been presented GraphiQL - an in-browser IDE for
exploring GraphQL.
If you wish to receive JSON, provide the header "Accept: application/json" or
add "&raw" to the end of the URL within a browser.
-->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>GraphiQL</title>
  <meta name="robots" content="noindex" />
  <meta name="referrer" content="origin" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      margin: 0;
      overflow: hidden;
    }
    #graphiql {
      height: 100vh;
    }
  </style>
  <style>
    /* graphiql/graphiql.css */
    ${loadFileStaticlyFromNPM('graphiql/graphiql.css')}
  </style>
  ${editorTheme.link || ''}
  <script>
    // promise-polyfill/dist/polyfill.min.js
    ${loadFileStaticlyFromNPM('promise-polyfill/dist/polyfill.min.js')}
  </script>
  <script>
    // unfetch/dist/unfetch.umd.js
    ${loadFileStaticlyFromNPM('unfetch/dist/unfetch.umd.js')}
  </script>
  <script>
    // react/umd/react.production.min.js
    ${loadFileStaticlyFromNPM('react/umd/react.production.min.js')}
  </script>
  <script>
    // react-dom/umd/react-dom.production.min.js
    ${loadFileStaticlyFromNPM('react-dom/umd/react-dom.production.min.js')}
  </script>
  <script>
    // graphiql/graphiql.min.js
    ${loadFileStaticlyFromNPM('graphiql/graphiql.min.js')}
  </script>
</head>
<body>
  <div id="graphiql">Loading...</div>
  <script>
    // Collect the URL parameters
    var parameters = {};
    window.location.search.substr(1).split('&').forEach(function (entry) {
      var eq = entry.indexOf('=');
      if (eq >= 0) {
        parameters[decodeURIComponent(entry.slice(0, eq))] =
          decodeURIComponent(entry.slice(eq + 1));
      }
    });
    // Produce a Location query string from a parameter object.
    function locationQuery(params) {
      return '?' + Object.keys(params).filter(function (key) {
        return Boolean(params[key]);
      }).map(function (key) {
        return encodeURIComponent(key) + '=' +
          encodeURIComponent(params[key]);
      }).join('&');
    }
    // Derive a fetch URL from the current URL, sans the GraphQL parameters.
    var graphqlParamNames = {
      query: true,
      variables: true,
      operationName: true
    };
    var otherParams = {};
    for (var k in parameters) {
      if (parameters.hasOwnProperty(k) && graphqlParamNames[k] !== true) {
        otherParams[k] = parameters[k];
      }
    }
    var fetchURL = locationQuery(otherParams);
    // Defines a GraphQL fetcher using the fetch API.
    function graphQLFetcher(graphQLParams) {
      return fetch(fetchURL, {
        method: 'post',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(graphQLParams),
        credentials: 'include',
      }).then(function (response) {
        return response.json();
      });
    }

    // When the query and variables string is edited, update the URL bar so
    // that it can be easily shared.
    function onEditQuery(newQuery) {
      parameters.query = newQuery;
      updateURL();
    }

    function onEditVariables(newVariables) {
      parameters.variables = newVariables;
      updateURL();
    }

    function onEditOperationName(newOperationName) {
      parameters.operationName = newOperationName;
      updateURL();
    }

    function updateURL() {
      history.replaceState(null, null, locationQuery(parameters));
    }

    // Render <GraphiQL /> into the body.
    ReactDOM.render(
      React.createElement(GraphiQL, {
        fetcher: graphQLFetcher,
        onEditQuery: onEditQuery,
        onEditVariables: onEditVariables,
        onEditOperationName: onEditOperationName,
        editorTheme: ${editorTheme.name && safeSerialize(editorTheme.name)},
        query: ${safeSerialize(queryString)},
        response: ${safeSerialize(resultString)},
        variables: ${safeSerialize(variablesString)},
        operationName: ${safeSerialize(operationName)},
        defaultQuery: ${safeSerialize(defaultQuery)},
      }),
      document.getElementById('graphiql')
    );
  </script>
</body>
</html>`;
}
