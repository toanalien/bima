# bima

**dành cho người chơi hệ nạp tiền**


![](https://i.imgur.com/2wKu8QC.png)

## Hướng dẫn sử dụng

1. Tạo Firebase Project
2. Deploy

![](https://i.imgur.com/9glNqTR.png)

```bash
firebase deploy --only functions
```

3. Dùng [Cloud Scheduler](https://cloud.google.com/scheduler) gọi interval vào endpoint Cloud Funtions

![](https://i.imgur.com/yTZ0dei.png)


## Todo

- [ ] Stoploss when abnormal volatility
- [ ] Create order via api signal
- [ ] Auto repay margin account
- [ ] Alert when orders changed status

## Donation

ETH: 0x8888889024545e12c36568d84e07f2a919069718

![](https://chart.googleapis.com/chart?chs=300x300&cht=qr&chl=0x8888889024545e12c36568d84e07f2a919069718&choe=UTF-8)
