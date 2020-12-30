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
const channel_id = functions.config().channel.id;
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
    let date = new Date();
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
*Balance*
Avg          : $${avg}
Max          : *$${max}*
Min          : $${min}
Last         : *$${last}*
Volatility : *${volatility}%*
${date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
    `
        var body = {
            channel_id: channel_id,
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
            let text = body['message']['text'];
            let host = req.get('host');

            if (!host.includes('localhost')) {
                var baseUrl = req.protocol + '://' + host;
                var options = {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                };
                if (text == 'o' || text == 'O') {
                    var url = `${baseUrl}/getOrder?token=${http_token}&force=true`;
                    options['url'] = url;
                    await axios(options);
                } else {
                    var url = `${baseUrl}/getAbnormalVolatility?token=${http_token}&force=true`;
                    options['url'] = url;
                    await axios(options);
                }
            }
        }
    }
    res.sendStatus(200);
})

exports.getOrder = functions.https.onRequest(async (req, res) => {
    let orders = await binance.sapi_get_margin_openorders({
        "symbol": "TOMOUSDT",
        "isIsolated": true
    });

    await map(orders, async _order => {
        let date = new Date(_order.updateTime);
        let text = `
*Open Order*
*${_order.symbol}*
price: ${_order.price}
origQty: ${_order.origQty}
executedQty: ${_order.executedQty}
side: *${_order.side}*
stopPrice: ${_order.stopPrice}
cost: *${parseFloat(_order.origQty * _order.price).toFixed(2)}*
${date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
            `
        var body = {
            channel_id: chat_id,
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
    })
    res.json();
})

exports.getMarginMytrades = functions.https.onRequest(async (req, res) => {
    const token = req.query.token;
    if (token != http_token) {
        return res.json({ "status": "failed", "data": "token not match" });
    }
    let trades = await binance.sapi_get_margin_mytrades({
        "symbol": "TOMOUSDT",
        "isIsolated": true
    })

    await map(trades, async _trade => {
        await admin.firestore().collection('trade').doc(_trade['id'].toString()).set(_trade, { merge: true });
    })
    let timestamp = Math.floor(new Date().setSeconds(0) / 1000);
    return res.json({ 'status': 'success', 'data': timestamp });
})

exports.notifyTrade = functions.firestore.document('/trade/{documentId}')
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
*Exec Trade*
*${after.symbol}*
price: ${after.price}
qty: ${after.qty}
side: *${side}*
cost: *${parseFloat(after.price * after.qty + after.commission).toFixed(2)}*
${date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
            `
            var body = {
                channel_id: channel_id,
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

exports.exchange = functions.https.onRequest(async (req, res) => {
    let host = req.get('host');
    if (host.includes('localhost')) {
        res.json(await binance);
    }
    res.json();
})

exports.getInterest = functions.https.onRequest(async (req, res) => {
    const token = req.query.token;
    if (token != http_token) {
        return res.json({ "status": "failed", "data": "token not match" });
    }
    let timestamp = Math.floor(new Date().setSeconds(0) / 1000);
    let interests = await binance.sapi_get_margin_interesthistory({ "isolatedSymbol": "TOMOUSDT" });
    await map(interests['rows'], async _interest => {
        await admin.firestore().collection('interest').doc(_interest['txId'].toString()).set(_interest, { merge: true });
    })

    return res.json({ 'status': 'success', 'data': timestamp });
})

exports.notifyInterest = functions.firestore.document('/interest/{documentId}')
    .onWrite(async (change, context) => {
        const docId = context.params.documentId;
        const before = change.before.data();
        const after = change.after.data();
        if (after == undefined) return;

        if (before == undefined || !before.hasOwnProperty('txId')) {
            let date = new Date(after.interestAccuredTime);
            let text = `
*Interest*
*${after.asset}*
principal: ${parseFloat(after.principal).toFixed(2)}
interest: *${parseFloat(after.interest).toFixed(4)}*
isolatedSymbol: *${after.isolatedSymbol}*
${date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
            `
            var body = {
                channel_id: channel_id,
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
