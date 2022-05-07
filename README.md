# Ground Control

### Installation

```shell script
npm install -g dtsgenerator
dtsgen openapi.yaml > src/openapi/api.ts
npm i
npm start
npm run worker-blockprocessor
npm run worker-processmempool
npm run worker-sender
```

### Environment variables

Set them as env variables or put them into `.env` file in project root dir.

- `JAWSDB_MARIA_URL` for example `mysql://username:password@host:port/database`
- `FCM_SERVER_KEY` hex encoded
- `APNS_PEM` hex encoded
- `BITCOIN_RPC` for example `http://username:password@host:8332`
- `APNS_TOPIC` for example `io.bluewallet.bluewallet`

### Getting certificates

https://dev.to/jakubkoci/react-native-push-notifications-313i

### Re-issue Apple certificate when it expires (yearly)

- create certificate signing request https://help.apple.com/developer-account/#/devbfa00fef7
- create certificate & export to p12 https://help.apple.com/developer-account/#/dev82a71386a
- convert .p12 to .pem `openssl pkcs12 -in push_certificates.p12 -out push_certificates.pem -nodes`
- get pem hex `xxd -p  push_certificates.pem  | tr -d '\n'`
- replace `APNS_PEM` environment variable on production (don't forget to restart)

### License

MIT
