
'use strict'

/**
 * Module dependencies.
 */

const debug = require('debug')('koa:application')
const assert = require('assert')
const onFinished = require('on-finished')
const response = require('./response')
const compose = require('koa-compose')
const context = require('./context')
const request = require('./request')
const statuses = require('statuses')
const Emitter = require('events')
const util = require('util')
const Stream = require('stream')
const http = require('http')
const only = require('only')
const { HttpError } = require('http-errors')

/** @typedef {typeof import ('./context') & {
 *  app: Application
 *  req: import('http').IncomingMessage
 *  res: import('http').ServerResponse
 *  request: KoaRequest
 *  response: KoaResponse
 *  state: any
 *  originalUrl: string
 * }} Context */

/** @typedef {typeof import('./request')} KoaRequest */

/** @typedef {typeof import('./response')} KoaResponse */

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 * 
 * Node.js的很多核心API都是建立在惯用的异步事件驱动架构上的，其中某些类型的对象（称为“发射器”）会发出命名事件，导致调用函数对象（“监听器”）。
 * 
 * 例如，`net.Server`对象在每次对等方连接到它时发出一个事件；`fs.ReadStream`在文件打开时发出一个事件；流在每次有数据可供读取时发出一个事件。
 * 
 * 所有发出事件的对象都是EventEmitter类的实例。这些对象公开一个eventEmitter.on()函数，允许将一个或多个函数附加到对象发出的命名事件上。
 * 通常，事件名称是驼峰式字符串，但可以使用任何有效的JavaScript属性键。
 * 
 * 当EventEmitter对象发出一个事件时，所有附加到该特定事件的函数都会同步地被调用。被调用的监听器返回的任何值都会被忽略和丢弃。
 * 
 * 以下示例展示了一个简单的EventEmitter实例，它有一个单独的监听器。使用eventEmitter.on()方法注册监听器，使用eventEmitter.emit()方法触发事件。
 * 
 * ```javascript
 * import { EventEmitter } from 'node:events';
 * class CustomEmitter extends EventEmitter {}
 * const emitter = new CustomEmitter();
 * emitter.on('event', () => {
 *  console.log('an event occurred!');
 * });
 * emitter.emit('event');
 * ```
 */
module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  /**
    *
    * @param {object} [options] Application options
    * @param {string} [options.env='development'] Environment
    * @param {string[]} [options.keys] Signed cookie keys
    * @param {boolean} [options.proxy] Trust proxy headers
    * @param {number} [options.subdomainOffset] Subdomain offset
    * @param {string} [options.proxyIpHeader] Proxy IP header, defaults to X-Forwarded-For
    * @param {number} [options.maxIpsCount] Max IPs read from proxy IP header, default to 0 (means infinity)
    *
    */

  constructor (options) {
    super()
    options = options || {}
    this.proxy = options.proxy || false
    this.subdomainOffset = options.subdomainOffset || 2
    this.proxyIpHeader = options.proxyIpHeader || 'X-Forwarded-For'
    this.maxIpsCount = options.maxIpsCount || 0
    this.env = options.env || process.env.NODE_ENV || 'development'
    this.compose = options.compose || compose
    if (options.keys) this.keys = options.keys
    this.middleware = []
    this.context = Object.create(context)
    this.request = Object.create(request)
    this.response = Object.create(response)
    // util.inspect.custom support for node 6+
    /* istanbul ignore else */
    if (util.inspect.custom) {
      this[util.inspect.custom] = this.inspect
    }
    if (options.asyncLocalStorage) {
      const { AsyncLocalStorage } = require('async_hooks')
      assert(AsyncLocalStorage, 'Requires node 12.17.0 or higher to enable asyncLocalStorage')
      this.ctxStorage = new AsyncLocalStorage()
    }
  }

  /**
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * 1. 创建http.Server实例，http.Server继承net.Server。net.Server创建一个TCP或IPC服务。
   * 2. 启动HTTP服务器监听连接。
   * 3. 添加一个监听器，监听'request'事件。监听器每次有请求时触发。每个连接可能有多个请求(在HTTP Keep-Alive连接的情况下)。
   * 
   * @param {Mixed} ...
   * @return {import('http').Server}
   * @api public
   */

  listen (...args) {
    debug('listen')
    const server = http.createServer(this.callback())
    return server.listen(...args)
  }

  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON () {
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ])
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect () {
    return this.toJSON()
  }

  /**
   * Use the given middleware `fn`.
   *
   * Old-style middleware will be converted.
   *
   * @param {(context: Context) => Promise<any | void>} fn
   * @return {Application} self
   * @api public
   */

  use (fn) {
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!')
    debug('use %s', fn._name || fn.name || '-')
    this.middleware.push(fn)
    return this
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * 1. 将一个包含中间件函数的数组对象，合成一个新函数。该函数在调用时将按照提供的顺序执行中间件函数。
   * 2. 每次有回调时，通过request和response创建context。
   * 3. 处理请求。
   * @return {Function}
   * @api public
   */

  callback () {
    // Koa应用程序是一个包含中间件函数数组的对象，这些函数以类似堆栈的方式组合并在请求时执行。
    const fn = this.compose(this.middleware)

    if (!this.listenerCount('error')) this.on('error', this.onerror)

    const handleRequest = (req, res) => {
      const ctx = this.createContext(req, res)
      if (!this.ctxStorage) {
        return this.handleRequest(ctx, fn)
      }
      return this.ctxStorage.run(ctx, async () => {
        return await this.handleRequest(ctx, fn)
      })
    }

    return handleRequest
  }

  /**
   * return current context from async local storage
   */
  get currentContext () {
    if (this.ctxStorage) return this.ctxStorage.getStore()
  }

  /**
   * Handle request in callback.
   * 
   * 1. 设置响应码为404。
   * 2. 中间层函数链对context进行处理。
   * 3. 如果中间层函数链执行没有错误发生，处理相应结果，否则，执行context的错误回调。
   * 4. response发射完成事件时，回调context的错误回调。
   *
   * @api private
   */

  handleRequest (ctx, fnMiddleware) {
    const res = ctx.res
    res.statusCode = 404
    const onerror = err => ctx.onerror(err)
    const handleResponse = () => respond(ctx)
    onFinished(res, onerror)
    return fnMiddleware(ctx).then(handleResponse).catch(onerror)
  }

  /**
   * Initialize a new context.
   *
   * @api private
   */

  createContext (req, res) {
    /** @type {Context} */
    const context = Object.create(this.context)
    /** @type {KoaRequest} */
    const request = context.request = Object.create(this.request)
    /** @type {KoaResponse} */
    const response = context.response = Object.create(this.response)
    context.app = request.app = response.app = this
    context.req = request.req = response.req = req
    context.res = request.res = response.res = res
    request.ctx = response.ctx = context
    request.response = response
    response.request = request
    context.originalUrl = request.originalUrl = req.url
    context.state = {}
    return context
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror (err) {
    // When dealing with cross-globals a normal `instanceof` check doesn't work properly.
    // See https://github.com/koajs/koa/issues/1466
    // We can probably remove it once jest fixes https://github.com/facebook/jest/issues/2549.
    const isNativeError =
      Object.prototype.toString.call(err) === '[object Error]' ||
      err instanceof Error
    if (!isNativeError) throw new TypeError(util.format('non-error thrown: %j', err))

    if (err.status === 404 || err.expose) return
    if (this.silent) return

    const msg = err.stack || err.toString()
    console.error(`\n${msg.replace(/^/gm, '  ')}\n`)
  }

  /**
   * Help TS users comply to CommonJS, ESM, bundler mismatch.
   * @see https://github.com/koajs/koa/issues/1513
   */

  static get default () {
    return Application
  }

  createAsyncCtxStorageMiddleware () {
    const app = this
    return async function asyncCtxStorage (ctx, next) {
      await app.ctxStorage.run(ctx, async () => {
        return await next()
      })
    }
  }
}

/**
 * Response helper.
 */

function respond (ctx) {
  // allow bypassing koa
  // 检查ctx.respond是否为false，如果是，则提前退出。
  if (ctx.respond === false) return

  // 检查响应是否可写。如果不可写，则退出。
  if (!ctx.writable) return

  // 从ctx中获取响应对象（res），请求体（body）和状态码（status）。
  const res = ctx.res
  let body = ctx.body
  const code = ctx.status

  // ignore body
  // 如果状态码为204（无内容）或304（未修改），则删除body和headers，并结束响应。
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null
    return res.end()
  }

  // 如果请求方法为HEAD，则结束响应。
  if (ctx.method === 'HEAD') {
    if (!res.headersSent && !ctx.response.has('Content-Length')) {
      const { length } = ctx.response
      if (Number.isInteger(length)) ctx.length = length
    }
    return res.end()
  }

  // status body
  // 如果body为null，则将状态码作为body发送（对于HTTP/2+），或发送默认消息。
  // 还设置Content-Type和Content-Length。
  if (body == null) {
    if (ctx.response._explicitNullBody) {
      ctx.response.remove('Content-Type')
      ctx.response.remove('Transfer-Encoding')
      ctx.length = 0
      return res.end()
    }
    if (ctx.req.httpVersionMajor >= 2) {
      body = String(code)
    } else {
      body = ctx.message || String(code)
    }
    if (!res.headersSent) {
      ctx.type = 'text'
      ctx.length = Buffer.byteLength(body)
    }
    return res.end(body)
  }

  // responses
  // 如果body是Buffer，则使用该Buffer结束响应。
  if (Buffer.isBuffer(body)) return res.end(body)
  // 如果body是字符串，则使用该字符串结束响应。
  if (typeof body === 'string') return res.end(body)
  // 如果body是流，则将该流导入响应中。
  if (body instanceof Stream) return body.pipe(res)

  // body: json
  // 如果以上情况都不是，则将body转换为JSON字符串，设置Content-Length，并使用JSON字符串结束响应。
  body = JSON.stringify(body)
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body)
  }
  res.end(body)
}

/**
 * Make HttpError available to consumers of the library so that consumers don't
 * have a direct dependency upon `http-errors`
 */

module.exports.HttpError = HttpError
