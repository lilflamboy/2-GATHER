'use strict'

let io = null

function setIo(nextIo) {
  io = nextIo
  return io
}

function getIo() {
  return io
}

module.exports = { setIo, getIo }
