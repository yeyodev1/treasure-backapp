import { MongoMemoryServer } from 'mongodb-memory-server'

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { port: 27217 } })
  console.log('MONGO_READY', mongod.getUri())
  // Se mantiene vivo hasta que lo maten.
  setInterval(() => {}, 60_000)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
