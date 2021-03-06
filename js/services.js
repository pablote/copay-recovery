var app = angular.module("recoveryApp.services", ['ngLodash']);
app.service('recoveryServices', ['$rootScope', '$http', 'lodash',
  function($rootScope, $http, lodash) {
    var bitcore = require('bitcore-lib');
    var Mnemonic = require('bitcore-mnemonic');
    var Transaction = bitcore.Transaction;
    var Address = bitcore.Address;
    var root = {};

    root.fromBackup = function(data, m, n, network) {

      if (!data.backup)
        return null;
      try {
        JSON.parse(data.backup);
      } catch (ex) {
        throw new Error("Your JSON is not valid, please copy only the text within (and including) the { } brackets around it.");
      };
      var payload;
      try {
        payload = sjcl.decrypt(data.password, data.backup);
      } catch (ex) {
        throw new Error("Incorrect backup password");
      };

      payload = JSON.parse(payload);

      if (!payload.n) {
        throw new Error("Backup format not recognized. If you are using a Copay Beta backup and version is older than 0.10, please see: https://github.com/bitpay/copay/issues/4730#issuecomment-244522614");
      }
      if ((payload.m != m) || (payload.n != n)) {
        throw new Error("The wallet configuration (m-n) does not match with values provided.");
      }
      if (payload.network != network) {
        throw new Error("Incorrect network.");
      }
      if (!(payload.xPrivKeyEncrypted) && !(payload.xPrivKey)) {
        throw new Error("The backup does not have a private key");
      }
      var xPriv = payload.xPrivKey;
      if (payload.xPrivKeyEncrypted) {
        try {
          xPriv = sjcl.decrypt(data.xPrivPass, payload.xPrivKeyEncrypted);
        } catch (ex) {
          throw new Error("Can not decrypt private key");
        }
      }
      var credential = {
        walletId: payload.walletId,
        copayerId: payload.copayerId,
        xPriv: xPriv,
        derivationStrategy: payload.derivationStrategy || "BIP45",
        addressType: payload.addressType || "P2SH",
        m: m,
        n: n,
        network: network,
        from: "backup",
      };
      return credential;
    }

    root.fromMnemonic = function(data, m, n, network) {
      if (!data.backup)
        return null;

      var words = data.backup;
      var passphrase = data.password;
      var xPriv;

      try {
        xPriv = new Mnemonic(words).toHDPrivateKey(passphrase, network).toString();
      } catch (ex) {
        throw new Error("Mnemonic wallet seed is not valid.");
      };

      var credential = {
        xPriv: xPriv,
        derivationStrategy: "BIP44",
        addressType: n == 1 ? "P2PKH" : "P2SH",
        m: m,
        n: n,
        network: network,
        from: "mnemonic",
      };
      return credential;
    }

    root.buildWallet = function(credentials) {
      credentials = lodash.compact(credentials);
      if (credentials.length == 0)
        throw new Error('No data provided');

      if (lodash.uniq(lodash.pluck(credentials, 'from')).length != 1)
        throw new Error('Mixed backup sources not supported');

      var result = lodash.pick(credentials[0], ["walletId", "derivationStrategy", "addressType", "m", "n", "network", "from"]);

      result.copayers = lodash.map(credentials, function(c) {
        if (c.walletId != result.walletId)
          throw new Error("Backups do not belong to the same wallets.");
        return {
          copayerId: c.copayerId,
          xPriv: c.xPriv,
        };
      });
      if (result.from == "backup") {
        if (lodash.uniq(lodash.compact(lodash.pluck(result.copayers, 'copayerId'))).length != result.copayers.length)
          throw new Error("Some of the backups belong to the same copayers");
      }

      console.log('Recovering wallet', result);

      return result;
    }

    root.getWallet = function(data, m, n, network) {
      var credentials = lodash.map(data, function(dataItem) {
        if (dataItem.backup.charAt(0) == '{')
          return root.fromBackup(dataItem, m, n, network);
        else
          return root.fromMnemonic(dataItem, m, n, network);
      });
      return root.buildWallet(credentials);
    }

    var PATHS = {
      'BIP45': ["m/45'/2147483647/0", "m/45'/2147483647/1"],
      'BIP44': {
        'testnet': ["m/44'/1'/0'/0", "m/44'/1'/0'/1"],
        'livenet': ["m/44'/0'/0'/0", "m/44'/0'/0'/1"]
      },
    }

    root.scanWallet = function(wallet, inGap, reportFn, cb) {
      reportFn("Getting addresses... GAP:" + inGap);

      // getting main addresses
      root.getActiveAddresses(wallet, inGap, reportFn, function(err, addresses) {
        reportFn("Active addresses:" + JSON.stringify(addresses));
        if (err) return cb(err);
        var utxos = lodash.flatten(lodash.pluck(addresses, "utxo"));
        var result = {
          addresses: addresses,
          balance: lodash.sum(utxos, 'amount'),
        }
        return cb(null, result);
      });
    }

    root.getPaths = function(wallet) {
      if (wallet.derivationStrategy == 'BIP45')
        return PATHS[wallet.derivationStrategy];
      if (wallet.derivationStrategy == 'BIP44')
        return PATHS[wallet.derivationStrategy][wallet.network];
    };

    root.getHdDerivations = function(wallet) {
      function deriveOne(xpriv, path, compliant) {
        var hdPrivateKey = bitcore.HDPrivateKey(xpriv);
        var xPrivKey = compliant ? hdPrivateKey.deriveChild(path) : hdPrivateKey.deriveNonCompliantChild(path);
        return xPrivKey;
      };

      function expand(groups) {
        if (groups.length == 1) return groups[0];

        function combine(g1, g2) {
          var combinations = [];
          for (var i = 0; i < g1.length; i++) {
            for (var j = 0; j < g2.length; j++) {
              combinations.push(lodash.flatten([g1[i], g2[j]]));
            };
          };
          return combinations;
        };

        return combine(groups[0], expand(lodash.tail(groups)));
      };

      var xPrivKeys = lodash.pluck(wallet.copayers, 'xPriv');
      var derivations = [];
      lodash.each(this.getPaths(wallet), function(path) {
        var derivation = expand(lodash.map(xPrivKeys, function(xpriv, i) {
          var compliant = deriveOne(xpriv, path, true);
          var nonCompliant = deriveOne(xpriv, path, false);
          var items = [];
          items.push({
            copayer: i + 1,
            path: path,
            compliant: true,
            key: compliant
          });
          if (compliant.toString() != nonCompliant.toString()) {
            items.push({
              copayer: i + 1,
              path: path,
              compliant: false,
              key: nonCompliant
            });
          }
          return items;
        }));
        derivations = derivations.concat(derivation);
      });

      return derivations;
    };

    root.getActiveAddresses = function(wallet, inGap, reportFn, cb) {
      var activeAddress = [];
      var inactiveCount;

      var baseDerivations = this.getHdDerivations(wallet);

      function exploreDerivation(i) {
        if (i >= baseDerivations.length) return cb(null, activeAddress);
        inactiveCount = 0;
        derive(baseDerivations[i], 0, function(err, addresses) {
          if (err) return cb(err);
          exploreDerivation(i + 1);
        });
      }

      function derive(baseDerivation, index, cb) {
        if (inactiveCount > inGap) return cb();

        var address = root.generateAddress(wallet, baseDerivation, index);
        root.getAddressData(address, wallet.network, function(err, addressData) {
          if (err) return cb(err);

          if (!lodash.isEmpty(addressData)) {
            reportFn('Address is Active!');
            activeAddress.push(addressData);
            inactiveCount = 0;
          } else
            inactiveCount++;

          reportFn('inactiveCount:' + inactiveCount);

          derive(baseDerivation, index + 1, cb);
        });
      }
      exploreDerivation(0);
    }

    root.generateAddress = function(wallet, derivedItems, index) {
      var derivedPrivateKeys = [];
      var derivedPublicKeys = [];

      lodash.each([].concat(derivedItems), function(item) {
        var hdPrivateKey = bitcore.HDPrivateKey(item.key);

        // private key derivation
        var derivedPrivateKey = hdPrivateKey.deriveChild(index).privateKey;
        derivedPrivateKeys.push(derivedPrivateKey);

        // public key derivation
        derivedPublicKeys.push(derivedPrivateKey.publicKey);
      });

      var address;
      if (wallet.addressType == "P2SH")
        address = bitcore.Address.createMultisig(derivedPublicKeys, wallet.m, wallet.network);
      else if (wallet.addressType == "P2PKH")
        address = Address.fromPublicKey(derivedPublicKeys[0], wallet.network);
      else
        throw new Error('Address type not supported');
      return {
        addressObject: address,
        pubKeys: derivedPublicKeys,
        privKeys: derivedPrivateKeys,
        info: derivedItems,
        index: index,
      };
    }

    root.getAddressData = function(address, network, cb) {
      // call insight API to get address information
      root.checkAddress(address.addressObject, network).then(function(respAddress) {
        // call insight API to get utxo information
        root.checkUtxos(address.addressObject, network).then(function(respUtxo) {
          var addressData = {
            address: respAddress.data.addrStr,
            balance: respAddress.data.balance,
            unconfirmedBalance: respAddress.data.unconfirmedBalance,
            utxo: respUtxo.data,
            privKeys: address.privKeys,
            pubKeys: address.pubKeys,
            info: address.info,
            index: address.index,
            isActive: respAddress.data.unconfirmedTxApperances + respAddress.data.txApperances > 0,
          };
          $rootScope.$emit('progress', lodash.pick(addressData, 'info', 'address', 'isActive', 'balance'));
          if (addressData.isActive)
            return cb(null, addressData);
          return cb();
        });
      });
    }

    root.checkAddress = function(address, network) {
      if (network == 'testnet')
        return $http.get('https://test-insight.bitpay.com/api/addr/' + address + '?noTxList=1');
      else
        return $http.get('https://insight.bitpay.com/api/addr/' + address + '?noTxList=1');
    }

    root.checkUtxos = function(address, network) {
      if (network == 'testnet')
        return $http.get('https://test-insight.bitpay.com/api/addr/' + address + '/utxo?noCache=1');
      else
        return $http.get('https://insight.bitpay.com/api/addr/' + address + '/utxo?noCache=1');
    }

    root.createRawTx = function(toAddress, scanResults, wallet, fee) {
      if (!toAddress || !Address.isValid(toAddress))
        throw new Error('Please enter a valid address.');

      var amount = parseInt((scanResults.balance * 1e8 - fee * 1e8).toFixed(0));

      if (amount <= 0)
        throw new Error('Funds are insufficient to complete the transaction');

      try {
        new Address(toAddress, wallet.network);
      } catch (ex) {
        throw new Error('Incorrect destination address network');
      }

      try {
        var privKeys = [];
        var tx = new Transaction();
        lodash.each(scanResults.addresses, function(address) {
          if (address.utxo.length > 0) {
            lodash.each(address.utxo, function(u) {
              if (wallet.addressType == 'P2SH')
                tx.from(u, address.pubKeys, wallet.m);
              else
                tx.from(u);
              privKeys = privKeys.concat(address.privKeys.slice(0, wallet.m));

            });
          }
        });
        tx.to(toAddress, amount);
        tx.sign(lodash.uniq(privKeys));

        var rawTx = tx.serialize();
        console.log("Raw transaction: ", rawTx);
        return rawTx;
      } catch (ex) {
        console.log(ex);
        throw new Error('Could not build tx: ' + ex);
      }
    }

    root.txBroadcast = function(rawTx, network) {
      if (network == 'testnet')
        return $http.post('https://test-insight.bitpay.com/api/tx/send', {
          rawtx: rawTx
        });
      else
        return $http.post('https://insight.bitpay.com/api/tx/send', {
          rawtx: rawTx
        });
    }

    return root;
  }
]);

app.directive('onReadFile', function($parse) {
  return {
    restrict: 'A',
    scope: false,
    link: function(scope, element, attrs) {
      var fn = $parse(attrs.onReadFile);

      element.on('change', function(onChangeEvent) {
        var reader = new FileReader();

        reader.onload = function(onLoadEvent) {
          scope.$apply(function() {
            fn(scope, {
              $fileContent: onLoadEvent.target.result
            });
          });
        };

        reader.readAsText((onChangeEvent.srcElement || onChangeEvent.target).files[0]);
      });
    }
  };
});
