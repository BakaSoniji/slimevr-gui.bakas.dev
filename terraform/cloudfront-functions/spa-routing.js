function handler(event) {
  const request = event.request;
  const uri = request.uri;
  const match = uri.match(/^\/([^/]+)\/(.*)/);
  if (match && (!match[2] || !match[2].match(/\.[a-zA-Z0-9]+$/))) {
    request.uri = `/${match[1]}/index.html`;
  }
  return request;
}
