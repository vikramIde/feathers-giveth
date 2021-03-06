/* eslint-disable no-param-reassign */
const Stream = require('stream');
const Web3 = require('web3');
const logger = require('winston');
const MemoryCache = require('memory-cache');
const BigNumber = require('bignumber.js');
const { Transform } = require('json2csv');
const { ObjectId } = require('mongoose').Types;
const { AdminTypes } = require('../../models/pledgeAdmins.model');
const { DonationStatus } = require('../../models/donations.model');

module.exports = function csv() {
  const app = this;

  const donationService = app.service('donations');
  const campaignService = app.service('campaigns');
  const milestoneService = app.service('milestones');
  const userService = app.service('users');

  const dappUrl = app.get('dappUrl');
  const { etherscan, homeEtherscan, foreignNetworkName, homeNetworkName } = app.get('blockchain');
  const tokenWhiteList = app.get('tokenWhitelist');

  const tokenBalanceKey = symbol => `token_${symbol}_balance`;

  const csvFields = [
    {
      label: 'Time',
      value: 'createdAt',
    },
    {
      label: 'Action',
      value: 'action',
    },
    {
      label: 'Action Taker Name',
      value: 'actionTakerName',
      default: 'Anonymous',
    },
    {
      label: 'Recipient',
      value: 'recipientName',
    },
    {
      label: 'Recipient Link',
      value: 'recipient',
    },
    {
      label: 'Amount',
      value: 'amount',
    },
    {
      label: 'Currency',
      value: 'currency',
    },
    ...tokenWhiteList.map(token => ({
      label: `Available ${token.symbol} Campaign Balance`,
      value: tokenBalanceKey(token.symbol),
      default: '0',
    })),
    {
      label: 'Action Taker Address',
      value: 'actionTakerAddress',
      default: 'NULL',
    },
    {
      label: `${foreignNetworkName} Transaction`,
      value: 'etherscanLink',
    },
    {
      label: `${homeNetworkName} Transaction`,
      value: 'homeEtherscanLink',
    },
  ];

  // Transform donations related to a campaign to csv items
  const getEntityLink = (entity, type) => {
    switch (type) {
      case AdminTypes.CAMPAIGN:
        return `${dappUrl}/campaigns/${entity._id.toString()}`;

      case AdminTypes.MILESTONE:
        return `${dappUrl}/campaigns/${entity.campaignId}/milestones/${entity._id.toString()}`;

      default:
        return '';
    }
  };

  const getEtherscanLink = txHash => {
    if (!etherscan || !txHash) return undefined;

    return `${etherscan}tx/${txHash}`;
  };

  const getHomeEtherscanLink = txHash => {
    if (!homeEtherscan || !txHash) return undefined;

    return `${homeEtherscan}tx/${txHash}`;
  };

  const donationDelegateStatus = async parentDonationId => {
    if (!parentDonationId) {
      return {
        isDelegate: false,
      };
    }

    const [parent] = await donationService.find({
      query: {
        _id: parentDonationId,
        $select: ['parentDonations', 'status', 'ownerTypeId'],
      },
      paginate: false,
    });

    if (!parent) {
      logger.error(`No parent donation with id ${parentDonationId} found`);
      return {
        isDelegate: false,
      };
    }

    if (parent.status === DonationStatus.COMMITTED) {
      return {
        isDelegate: true,
        parentOwnerTypeId: parent.ownerTypeId,
      };
    }

    if (parent.parentDonations.length === 0) {
      return {
        isDelegate: false,
      };
    }

    return donationDelegateStatus(parent.parentDonations[0]);
  };

  const newCampaignDonationsTransform = campaignId => {
    const campaignBalance = {};

    const updateCampaignBalance = (donation, isDelegate, parentId) => {
      const { ownerTypeId, amount, token } = donation;

      let balanceChange;
      if (ownerTypeId === campaignId) {
        balanceChange = new BigNumber(amount.toString());
      } else if (isDelegate && parentId === campaignId) {
        balanceChange = new BigNumber(amount.toString()).negated();
      } else {
        // Does not affect campaign balance
        return;
      }

      const { symbol } = token;
      const currentBalance = campaignBalance[symbol];
      if (!currentBalance) {
        campaignBalance[symbol] = balanceChange;
      } else {
        campaignBalance[symbol] = currentBalance.plus(balanceChange);
      }
    };

    return new Stream.Transform({
      objectMode: true,
      async transform(donation, _, callback) {
        const {
          txHash,
          homeTxHash,
          amount,
          giverAddress,
          ownerEntity,
          ownerType,
          token,
          createdAt,
          parentDonations,
          actionTakerAddress,
          status,
          isReturn,
        } = donation;

        let action;
        let realActionTakerAddress;

        if (isReturn) {
          action = 'Return';
          realActionTakerAddress = actionTakerAddress;
          updateCampaignBalance(donation, false);
        } else {
          const { isDelegate, parentOwnerTypeId } = await donationDelegateStatus(
            parentDonations[0],
          );
          realActionTakerAddress = isDelegate ? actionTakerAddress : giverAddress;
          action = isDelegate ? 'Delegated' : 'Direct Donation';
          if (status === DonationStatus.CANCELED) {
            action += ' - Canceled Later';
          }
          updateCampaignBalance(donation, isDelegate, parentOwnerTypeId);
        }

        const [actionTaker] = await userService.find({
          query: {
            address: realActionTakerAddress,
            $select: ['name'],
            $limit: 1,
          },
          paginate: false,
        });

        const result = {
          recipientName: ownerEntity.title,
          recipient: getEntityLink(ownerEntity, ownerType),
          currency: token.name,
          amount: Web3.utils.fromWei(amount).toString(),
          action,
          createdAt: createdAt.toString(),
          etherscanLink: getEtherscanLink(txHash),
          homeEtherscanLink: getHomeEtherscanLink(homeTxHash),
          actionTakerName: actionTaker ? actionTaker.name : undefined,
          actionTakerAddress: realActionTakerAddress,
        };

        Object.keys(campaignBalance).forEach(symbol => {
          result[tokenBalanceKey(symbol)] = Web3.utils.fromWei(campaignBalance[symbol].toFixed());
        });

        callback(null, result);
      },
    });
  };

  // Get stream of donations whose owner are campaign id and its milestones
  const getDonationStream = async id => {
    const milestones = await milestoneService.find({
      query: {
        campaignId: id,
        $select: ['_id'],
      },
      paginate: false,
    });

    const query = {
      status: { $in: [DonationStatus.COMMITTED, DonationStatus.CANCELED] },
      ownerTypeId: { $in: [id, ...milestones.map(m => m._id)] },
      $sort: { createdAt: 1 },
      $select: [
        '_id',
        'giverAddress',
        'ownerType',
        'ownerTypeId',
        'txHash',
        'homeTxHash',
        'amount',
        'createdAt',
        'token',
        'parentDonations',
        'actionTakerAddress',
        'status',
        'isReturn',
      ],
    };

    let totalCount = 0;
    let cache = [];
    let noMoreData = false;

    const readable = new Stream.Readable({
      read() {
        if (cache.length > 0) {
          readable.push(cache.shift());
          return;
        }

        if (noMoreData) {
          readable.push(null);
          return;
        }

        donationService
          .find({
            query: {
              ...query,
              $skip: totalCount,
              $limit: 20,
            },
            schema: 'includeTypeDetails',
          })
          .then(result => {
            const { data } = result;
            totalCount += data.length;
            if (totalCount === result.total) {
              noMoreData = true;
            }
            cache = data;
            readable.push(cache.shift());
          });
      },
      objectMode: true,
    });

    return readable;
  };

  const getCampaignInfo = {
    async get(id) {
      if (!id || !ObjectId.isValid(id)) {
        return { error: 400 };
      }

      const result = await campaignService.find({
        query: {
          _id: id,
          $limit: 1,
          $select: ['_id', 'updatedAt'],
        },
      });
      if (result.total !== 1) {
        return { error: 404 };
      }

      return { campaignId: id, updatedAt: result.data[0].updatedAt };
    },
  };

  // Transform csv items in json format to csv format
  const newCsvTransform = () => {
    return new Transform({ fields: csvFields }, { objectMode: true });
  };

  const csvService = async (req, res, next) => {
    const { campaignId } = req;
    res.type('csv');
    res.setHeader('Content-disposition', `attachment; filename=${campaignId}.csv`);

    const donationStream = await getDonationStream(campaignId);
    const chunks = [];
    donationStream
      .on('error', next)
      .pipe(newCampaignDonationsTransform(campaignId))
      .on('error', next)
      .pipe(newCsvTransform())
      .on('error', next)
      .on('data', chunk => {
        chunks.push(chunk);
      })
      .on('finish', () => {
        res.send(chunks.join(''));
      });
  };

  const cacheMiddleWare = (req, res, next) => {
    const { error, campaignId, updatedAt } = res.data;

    if (error) {
      res.status(error).end();
      return;
    }

    const value = MemoryCache.get(campaignId);

    if (value && value.updatedAt.getTime() === updatedAt.getTime()) {
      res.type('csv');
      res.setHeader('Content-disposition', `attachment; filename=${campaignId}.csv`);
      res.send(value.body);
      return;
    }

    res.sendResponse = res.send;
    res.send = body => {
      MemoryCache.put(campaignId, { updatedAt, body });
      res.sendResponse(body);
      res.end();
    };

    req.campaignId = campaignId;

    next();
  };

  // Initialize our service with any options it requires
  app.use('/campaigncsv/', getCampaignInfo, cacheMiddleWare, csvService);
};
