"use strict";
const ccxt = require('ccxt');
const { forEach, filter, map, reduce } = require('p-iteration');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios')

admin.initializeApp({});

const api_key = functions.config().api.key;
const api_secret = functions.config().api.secret;
const http_token = functions.config().http.token;
const chat_id = functions.config().chat.id;
const bot_token = functions.config().bot.token;
var url = `https://api.telegram.org/bot${bot_token}/sendMessage`;

let binance = new ccxt.binance({
    'apiKey': api_key,
    'secret': api_secret
})

exports.fetchMarkets = functions.https.onRequest(async (req, res) => {
    const token = req.query.token;
    const pair = req.query.pair;
    if (token != http_token) {
        return res.json({ "ok": "false", "error_code": 0, "description": "token not match" });
    }

    pair = pair.toUpperCase();
    let orderBook = await binance.fetchOrderBook(pair);
    let bid = orderBook['bids'][0];
    let ask = orderBook['asks'][0];

    res.json({ bid, ask });
})

exports.getMarginIsolatedAccount = functions.https.onRequest(async (req, res) => {
    const token = req.query.token;
    if (token != http_token) {
        return res.json({ "status": "failed", "data": "token not match" });
    }
    let timestamp = Math.floor(new Date().setSeconds(0) / 1000);
    let marginIsolatedAccount = await binance.sapi_get_margin_isolated_account();

    await forEach(['totalNetAssetOfBtc', 'totalAssetOfBtc', 'totalLiabilityOfBtc'], async _key => {
        marginIsolatedAccount[_key] = parseFloat(marginIsolatedAccount[_key]);
    })

    let assets = await filter(marginIsolatedAccount['assets'], async asset => {
        return asset['baseAsset']['netAsset'] > 0 || asset['quoteAsset']['netAsset'] > 0;
    })

    assets = await map(assets, async _asset => {
        await forEach(['indexPrice', 'marginRatio', 'liquidateRate', 'liquidatePrice', 'marginLevel'], async _key => {
            _asset[_key] = parseFloat(_asset[_key]);
        })
        await forEach(['netAsset', 'totalAsset', 'interest', 'netAssetOfBtc', 'free', 'locked', 'borrowed'], async _key => {
            _asset['baseAsset'][_key] = parseFloat(_asset['baseAsset'][_key]);
            _asset['quoteAsset'][_key] = parseFloat(_asset['quoteAsset'][_key]);
        })
        return _asset;
    })

    marginIsolatedAccount['assets'] = assets;
    marginIsolatedAccount['timestamp'] = timestamp;

    let orderBook = await binance.fetchOrderBook('BTC/USDT');
    let bid = orderBook['bids'][0];

    let totalNetAssetOfUsdt = marginIsolatedAccount['totalNetAssetOfBtc'] * bid[0];
    marginIsolatedAccount['totalNetAssetOfUsdt'] = totalNetAssetOfUsdt;
    await admin.firestore().collection('marginIsolated').doc(timestamp.toString()).set(marginIsolatedAccount);

    let marginOpenOrders = await binance.sapi_get_margin_openorders({
        "symbol": "TOMOUSDT",
        "isIsolated": true
    })
    console.log(marginOpenOrders)
    await map(marginOpenOrders, async _order => {
        await admin.firestore().collection('order').doc(_order['orderId'].toString()).set(_order, { merge: true });
    })

    return res.json({ 'status': 'success', 'data': timestamp });
})

exports.getAbnormalVolatility = functions.https.onRequest(async (req, res) => {
    const token = req.query.token;
    const force = req.query.force;
    if (token != http_token) {
        return res.json({ "status": "failed", "data": "token not match" });
    }
    let marginIsolateds = [];
    let timestamp = Math.floor(new Date().setSeconds(0) / 1000);
    let from = timestamp - 14 * 60 * 5;
    let snapshot = await admin.firestore().collection('marginIsolated').where('timestamp', '>=', from).orderBy('timestamp').get();

    snapshot.forEach(doc => { marginIsolateds.push(doc.data()) });

    let last = parseFloat(marginIsolateds.pop()['totalNetAssetOfUsdt'].toFixed(2));

    let max = parseFloat(marginIsolateds[0]['totalNetAssetOfUsdt'].toFixed(2));
    let min = parseFloat(marginIsolateds[0]['totalNetAssetOfUsdt'].toFixed(2));

    let sum = await reduce(marginIsolateds, async (accumulator, currentValue, index, array) => {
        if (max < currentValue['totalNetAssetOfUsdt']) {
            max = parseFloat(currentValue['totalNetAssetOfUsdt'].toFixed(2));
        }

        if (min > currentValue['totalNetAssetOfUsdt']) {
            min = parseFloat(currentValue['totalNetAssetOfUsdt'].toFixed(2));
        }

        return accumulator + currentValue['totalNetAssetOfUsdt']
    }, 0);

    let avg = parseFloat((sum / marginIsolateds.length).toFixed(2));

    let volatility = parseFloat(((last / avg - 1) * 100).toFixed(2));

    if (volatility < -2 || volatility > 2 || force == 'true') {
        let text = `
Avg          : $${avg}
Max          : *$${max}*
Min          : $${min}
Last         : *$${last}*
Volatility : *${volatility}%*
${new Date().toUTCString()}
    `
        var body = {
            chat_id: chat_id,
            disable_web_page_preview: true,
            parse_mode: 'markdown',
            text: text,
        }

        var options = {
            method: 'POST',
            url: url,
            headers: {
                'Content-Type': 'application/json'
            },
            data: body
        };

        var results = await axios(options);
        console.log(results);

    }


    res.json({ sum, avg, last, volatility });
})

exports.telehook = functions.https.onRequest(async (req, res) => {

    if (req.method == 'POST') {
        let body = req.body;
        if (body.hasOwnProperty('message') && body['message'].hasOwnProperty('text')) {
            // var reCheckPrice = /p\s+(.*)/i;
            // let text = body['message']['text'];
            // let pair = text.match(reCheckPrice);
            // if (pair.length == 2) {
            //     pair = pair[1];

            // }

            let host = req.get('host');

            if (!host.includes('localhost')) {
                var baseUrl = req.protocol + '://' + host;
                var url = `${baseUrl}/getAbnormalVolatility?token=${http_token}&force=true`;
                var options = {
                    method: 'GET',
                    url: url,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                };
                await axios(options);
            }
        }
    }
    res.sendStatus(200);
})

exports.order = functions.https.onRequest(async (req, res) => {
    res.json(await binance.sapi_get_margin_openorders({
        "symbol": "TOMOUSDT",
        "isIsolated": true
    }))
})

exports.myTrades = functions.https.onRequest(async (req, res) => {
    const token = req.query.token;
    if (token != http_token) {
        return res.json({ "status": "failed", "data": "token not match" });
    }
    let trades = await binance.sapi_get_margin_mytrades({
        "symbol": "TOMOUSDT",
        "isIsolated": true
    })

    await map(trades, async _trade => {
        await admin.firestore().collection('trade').doc(_trade['orderId'].toString()).set(_trade, { merge: true });
    })
    return res.json({ 'status': 'success', 'data': timestamp });
})

exports.notifyOrder = functions.firestore.document('/trade/{documentId}')
    .onWrite(async (change, context) => {
        const docId = context.params.documentId;
        const before = change.before.data();
        const after = change.after.data();
        if (after == undefined) return;

        if (before == undefined || !before.hasOwnProperty('id')) {
            let date = new Date(after.time);
            let side = 'Buy';
            if (after.isBuyer == false) side = 'Sell';
            let text = `
*${after.symbol}*
price: ${after.price}
qty: ${after.qty}
side: *${side}*
cost: *${parseFloat(after.price * after.qty + after.commission).toFixed(2)}*
${date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
            `
            var body = {
                chat_id: chat_id,
                disable_web_page_preview: true,
                parse_mode: 'markdown',
                text: text,
            }

            var options = {
                method: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: body
            };

            var results = await axios(options);
            console.log(results);
        }
    });
