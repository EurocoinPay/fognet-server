const express = require("express")
const bodyParser = require("body-parser")
const storage = require("../libs/storage")
const Flash = require("../libs/iota.flash.js")
const multisig = Flash.multisig
const channel = require("../libs/channel")
const cors = require("cors")
const crypto = require("crypto")
var Inliner = require('inliner')
var serialport = require('serialport');

const app = express()
app.use(cors())
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
var Serial = {}

serialport.list(function (err, ports) {
  var port = ports.find(p=>p.comName.includes('/dev/tty.usbmodem'))
  if(port){
    console.log('found teensy ' + port.comName)
    Serial = new serialport(port.comName, 9600)
    Serial.on('data', unChunk)
  } else {
    console.log('no nRF52832 found')
  }
})

function str2ab(str) {
  var buf = new ArrayBuffer(str.length*2); // 2 bytes for each char
  var bufView = new Uint16Array(buf);
  for (var i=0, strLen=str.length; i<strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

var packets = []
function unChunk(data) {
  const text = String.fromCharCode.apply(null, data)
  console.log("RECIEVED SERIAL ",text)
  if(text.includes('<*>')){
    const cmd = text.substr(3,15).replace(/\s/g, '')
    packets = []
  } else if (text.includes('<^>')){
    const cmd = text.substr(3,15).replace(/\s/g, '')
    var s = ''
    packets.forEach(function(p){
      s += p.substr(0,18)
    })
    BleActions[cmd](s)
    packets = []
  } else {
    packets.push(text)
  }
}

function serialWrite(data){
  return new Promise(function(resolve,reject){
    let wait = setTimeout(() => {
      clearTimeout(wait)
      Serial.write(data, function(err) {
        console.log('Send BLE', data)
        if (err) {
          reject('Error on write: ', err.message)
        }
        resolve('message written')
      })
    }, 100) // todo: remove this delay, use value request instead
  })
}

function BleAPI(cmd, data) {
  console.log(`/${cmd} ${data.length}`)
  const num = Math.ceil(data.length / 18)
  const packets = []
  packets.push(`<*>${cmd}<*>${num}`)
  for(var i=0; i<num; i++){
    packets.push(data.substr(i*18, 18))
  }
  packets.push(`<^>${cmd}`)
  console.log("==========PUSH BACK TO TEENSY==========")
  packets.reduce((prev, val) => {
    return prev.then(() => serialWrite(val + '\r\n'))
  }, Promise.resolve())
}

const BleActions = {
  web:function(s){
    // sending "testing" right back to teensy
    //BleAPI('web', s.replace(/ /g,''))
    new Inliner(s.replace(/ /g,''), (error, html) => {
      BleAPI('web', html)
      //const byteArray = chunk(s)
      //console.log(byteArray)
    })
  }
}

app.get('/test', (req, res, next) => {
  console.log('/test!')
  return "hi"
})

app.post('/fognetdemo', (req, res, next) => {
  console.log('/fognetdemo ', req.body.url)

  new Inliner(req.body.url, (error, html) => {
    // compressed and inlined HTML page
    return res.json({
      html: html
    })
  })
})

const SEED =
  "DDVZVZ9QJPUGMDAKGPTEUBOS9AWWVWF99MCKNIXALMKJRBGSQMXOVBRKHSJNOVMBZJRRRMVNXJCKPXPXJ"

app.post("/register", (req, res, next) => {
  console.log('/register ', req.body.id)
  storage.get("channel_" + req.body.id, (err, state) => {
    if (state) {
      return res.json({ error: "Channel already exists" })
    }
    channel.getSubseed(SEED, (err, seed) => {
      if (err) {
        return res.send(500).json({ error: "Internal server error" })
      }
      const digests = req.body.digests
      flash = {
        index: 0,
        security: 2,
        deposit: [req.body.amount, 0],
        outputs: {},
        transfers: [],
        signersCount: 2
      }
      let myDigests = digests.map(() =>
        multisig.getDigest(seed, flash.index++, flash.security)
      )
      {
        // compose multisigs, write to remainderAddress and root
        let multisigs = digests.map((digest, i) => {
          let addy = multisig.composeAddress([digest, myDigests[i]])
          addy.index = myDigests[i].index
          addy.security = 2
          addy.signingIndex = 2
          addy.securitySum = 4
          return addy
        })
        flash.remainderAddress = multisigs.shift()
        for (let i = 1; i < multisigs.length; i++) {
          multisigs[i - 1].children.push(multisigs[i])
        }
        flash.root = multisigs.shift()
      }
      storage.set(
        "channel_" + req.body.id,
        {
          seed: seed,
          flash: flash
        },
        err => {
          if (err) {
            return res.send(500).end()
          }
          return res.json({
            digests: myDigests
          })
        }
      )
    })
  })
})

app.post("/branch", (req, res, next) => {
  console.log('/branch ', req.body.id)
  storage.get("channel_" + req.body.id, (err, state) => {
    if (!state) {
      return res.status(404).json({ error: "Channel not registered" })
    }
    const clientDigests = req.body.digests
    let myDigests = clientDigests.map(() =>
      multisig.getDigest(state.seed, state.flash.index++, state.flash.security)
    )
    {
      // compose multisigs, write to remainderAddress and root
      let multisigs = clientDigests.map((digest, i) => {
        let addy = multisig.composeAddress([digest, myDigests[i]])
        addy.index = myDigests[i].index
        addy.security = 2
        addy.signingIndex = 2
        addy.securitySum = 4
        return addy
      })
      for (let i = 1; i < multisigs.length; i++) {
        multisigs[i - 1].children.push(multisigs[i])
      }
      let node = state.flash.root
      while (node.address != req.body.address) {
        node = node.children[node.children.length - 1]
      }
      node.children.push(multisigs[0])
    }
    storage.set("channel_" + req.body.id, state, err => {
      if (err) {
        return res.send(500).end()
      }
      return res.json({
        digests: myDigests
      })
    })
  })
})

app.post("/address", (req, res, next) => {
  console.log('/address ', req.body.id)
  const clientDigest = req.body.digest
  const digest = channel.getNewDigest(req.body.id, (err, digest) => {
    if (err) {
      return res.status(404).json({ error: "Unknown channel" })
    }
    return res.json({
      address: channel.getAddress([clientDigest, digest])
    })
  })
})

app.post("/purchase", (req, res, next) => {
  console.log('/purchase', req.body.id)
  const bundles = req.body.bundles
  channel.processTransfer(req.body.id, bundles, (err, signatures) => {
    if (err) {
      return res.status(404).json({ error: "Unknown channel" })
    }
    if (!signatures) {
      return res.status(403).json({ error: "Invalid transfer" })
    }
    const key = crypto.randomBytes(50).toString("hex")
    return res.json({ bundles: signatures })
  }) 
})

app.post("/close", (req, res, next) => {
  console.log('/close ', req.body.id)
  const bundles = req.body.bundles
  channel.processTransfer(
    req.body.id,
    { value: 0 },
    bundles,
    (err, signatures) => {
      if (err) {
        return res.status(404).json({ error: "Unknown channel" })
      }
      if (!signatures) {
        return res.status(403).json({ error: "Invalid transfer" })
      }

      storage.set(req.body.id + "_close", signatures, err => {
        if (err) {
          return res.status(500).json({ error: "Internal server error" })
        }
        return res.json({ bundles: signatures })
      })
    }
  )
})

app.post("/item", (req, res) => {
  console.log('/item ', req.body.id)
  /* if (req.get('Authorization') !== '') {
    res.status(403).end();
    return;
  }*/
  var item = {
    id: req.body.id,
    value: req.body.value
  }
  if (req.body.content) item.content = req.body.content
  storage.set("item_" + item.id, item, err => {
    if (err) {
      return res.status(500).end()
    }
    return res.json(item)
  })
})

app.get("/item/:item/:key", (req, res, next) => {
  storage.get(req.params.item + "_" + req.params.key, (err, exists) => {
    if (err) {
      return res.status(500).json({ error: "Internal server error" })
    }
    if (exists !== 1) {
      return res.status(403).json({ error: "Unauthorized" })
    }

    storage.get("item_" + req.params.item, (err, data) => {
      if (err) {
        return res.status(500).end()
      }
      if (data.content) return res.json(data.content)

      var options = {
        root: __dirname + "/public"
      }
      // Respond with the file
      return res.sendFile(req.params.item, options, function(err) {
        // Throw if file doesn't exist
        if (err) {
          return res.status(403).json({ error: "File not found" })
        }
      })
    })
  })
})

app.listen(8081, function() {
  console.log("Listening on port 8081!")
})
