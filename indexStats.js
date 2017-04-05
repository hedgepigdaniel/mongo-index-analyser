

DB.prototype.indexStats = function() {
  var BATCH_SIZE = 100;
  var DEBUG = true;
  var database = db.getName();
  var IGNORED_OPERATORS = ["insert", "killcursors", "getmore"];
  var IGNORED_COMMANDS = ["listIndexes", "dbStats", "profile", "collStats"];

  var unknown_operators = {};
  var unknown_command_keys = {};

  var index_use_counts = {};
  var collscan_queries = {};
  var inefficient_ixscan_queries = {};
  var inefficient_sort_queries = {};

  var collections_with_missing_info = {};

  var collectionNameFromProfileDocument = function(profile_document) {
    return profile_document.ns.replace(/^[^.]*\./, "");
  };

  var createIndexUseCountsFromIndexes = function() {
    var collections = db.getCollectionNames();
    for (var i in collections) {
      var collection = collections[i];
      index_use_counts[collection] = {};
      var indexes = db[collection].getIndexes();
      for (var j in indexes) {
        var index = indexes[j];
        var defalt_name = convertKeySpecListToIndexName(index.key);
        index_use_counts[collection][defalt_name] = 0;
      }
    }
  };

  var recordUseOfIndex = function(collection_name, index_name) {
    if (!index_use_counts[collection_name]) {
      index_use_counts[collection_name] = {};
    }
    if (!index_use_counts[collection_name][index_name]) {
      index_use_counts[collection_name][index_name] = 0;
    }
    index_use_counts[collection_name][index_name]++;
  };

  var convertKeySpecListToIndexName = function(spec) {
    var key_names = Object.keys(spec).map(function(key) {
      return key + "_" + spec[key];
    });
    return key_names.join("_");
  };

  var convertSummaryToIndexName = function(collection_name, summary) {
    var json = summary.replace(/[A-z_.][A-z0-9_.]+/g, "\"$&\"");
    try {
      var spec = JSON.parse (json);
    } catch (e) {
      collections_with_missing_info[collection_name] = true;
      return null;
    }
    return convertKeySpecListToIndexName(spec);
  };

  var recordIndexUseFromSummary = function(collection_name, summary) {
    var clauses = summary.match(/IXSCAN\s*{.*?}/g);
    for (var i = 0; i < clauses.length; i++) {
      var clause = clauses[i];
      var index_name = convertSummaryToIndexName(collection_name, clause.replace(/^IXSCAN /, ""));
      if (index_name !== null) {
        recordUseOfIndex(collection_name, index_name);
      }
    }
  };

  var updateIndexCounts = function(exec_stats, collection_name, profile_document) {
    if (exec_stats.stage === "IXSCAN" || exec_stats.stage === "COUNT_SCAN" || exec_stats.stage === "IDHACK") {
      // An index was used
      var index_name;
      if (exec_stats.stage === "IDHACK") {
        index_name = "_id_1";
      } else {
        index_name = exec_stats.indexName
      }
      recordUseOfIndex(collection_name, index_name);
    } else if (exec_stats.stage === "COLLSCAN") {
      // The entire collection was scanned and no index was used at all
      if (profile_document.nScannedObjects > 1000) {
        var query_string = JSON.stringify (profile_document);
        collscan_queries[query_string] = {
          document: profile_document,
          n_scanned: profile_document.nScannedObjects,
        };
      }
    } else if (exec_stats.stage === "SORT") {
      if (exec_stats.memUsage > 1048576) {
        // An index was not used for sorting and the sort used more than 1MB of memory
        var query_string = JSON.stringify (profile_document);
        inefficient_sort_queries[query_string] = {
          document: profile_document,
          mem_usage: exec_stats.memUsage,
        };
      }
    } else if (exec_stats.stage == "FETCH" ||
        exec_stats.stage == "SUBPLAN" ||
        exec_stats.stage == "OR" ||
        exec_stats.stage == "CACHED_PLAN" ||
        exec_stats.stage == "COUNT" ||
        exec_stats.stage == "LIMIT" ||
        exec_stats.stage == "PROJECTION" ||
        exec_stats.stage == "UPDATE" ||
        exec_stats.stage == "SKIP" ||
        exec_stats.stage == "DELETE" ||
        exec_stats.stage == "SORT_MERGE") {
      if (exec_stats.stage === 'FETCH') {
        if (exec_stats.nReturned + 1000 < exec_stats.docsExamined) {
          // This means that although an index was used, at least 100
          // documents were filtered out after the index was applied
          var query_string = JSON.stringify(profile_document);
          inefficient_ixscan_queries[query_string] = {
            document: profile_document,
            surplus_scans: exec_stats.docsExamined - exec_stats.nReturned,
          };
        }
      }
      if (exec_stats.inputStage) {
        updateIndexCounts(exec_stats.inputStage, collection_name, profile_document);
      } else if (exec_stats.inputStages) {
        for (var i in exec_stats.inputStages) {
          updateIndexCounts(exec_stats.inputStages[i], collection_name, profile_document);
        }
      }
    } else if (exec_stats.stage === "EOF") {
      // Not sure what this means but I don't think it matters
    } else if (exec_stats.summary) {
      // mongo cbfed printing the information
      if (exec_stats.summary.startsWith("IXSCAN")) {
        recordIndexUseFromSummary(collection_name, exec_stats.summary);
      } else {
        collections_with_missing_info[collection_name] = true;
      }
    } else {
      print(JSON.stringify(profile_document));
      print(JSON.stringify(exec_stats));
      throw Error("Unknown stage: " + exec_stats.stage);
    }
  };

  createIndexUseCountsFromIndexes();

  var query = {
    ns: {
      "$ne": database + ".system.profile"
    },
    "command.explain": {
      "$exists": false
    }
  };

  db.system.profile.find(query).sort({"$natural": -1}).addOption(DBQuery.Option.noTimeout).batchSize(BATCH_SIZE).forEach(function(profile_document) {

    switch(profile_document.op) {
      case "query":
        var collection = collectionNameFromProfileDocument (profile_document);
        updateIndexCounts (profile_document.execStats, collection, profile_document);
        break;

      case "update":
        var collection = collectionNameFromProfileDocument (profile_document);
        if (profile_document.updateobj instanceof Object) {
          var explain = db[collection].explain().update(profile_document.query, profile_document.updateobj);
          updateIndexCounts(explain.queryPlanner.winningPlan, collection, profile_document);
        } else {
          // Sometimes when the update object is large it comes out has a kind of json like string...
          collections_with_missing_info[collection] = true;
        }
        break;

      case "remove":
        var collection = collectionNameFromProfileDocument(profile_document);
        var explain = db[collection].explain().remove(profile_document.query);
        updateIndexCounts(explain.queryPlanner.winningPlan, collection, profile_document);
        break;

      case "command":
        var command = profile_document.command;
        if (!(command instanceof Object)) {
          // Happens when the command is very long - becomes an ellipsised string
          // This is a hack to get the collection name out (the value of the first
          // key in the incomplete JSON object)
          var prefix = new RegExp("\\{ [A-z]+:[^\"]*\"");
          var postfix = new RegExp("[^A-z].*$");
          var collection = command.replace(prefix, "").replace(postfix, "");
          collections_with_missing_info[collection] = true;
          return;
        }
        if (command.aggregate) {
          var collection = command.aggregate;
          var explain = db[collection].explain().aggregate(command.pipeline);
          for (var i in explain.stages) {
            var stage = explain.stages[i];
            if (stage['$cursor']) {
              updateIndexCounts(stage['$cursor'].queryPlanner.winningPlan, collection, explain.stages);
            }
          }
        } else if (command.count) {
          var collection = command.count;
          var explain = db[collection].explain().count(command.query);
          updateIndexCounts(explain.queryPlanner.winningPlan, collection, profile_document);
        } else if (command.distinct) {
          var collection = command.distinct;
          var explain = db[collection].explain().find(command.query).finish();
          updateIndexCounts(explain.queryPlanner.winningPlan, collection, profile_document);
        } else if (command.findAndModify) {
          var collection = command.findAndModify;
          var explain = db[collection].explain().find(command.query);
          if (command.sort) {
            explain = explain.sort(command.sort);
          }
          explain = explain.finish();
          updateIndexCounts(explain.queryPlanner.winningPlan, collection, profile_document);
        } else if (command.mapreduce) {
          var collection = command.mapreduce;
          var explain = db[collection].explain().find(command.query).finish();
          updateIndexCounts(explain.queryPlanner.winningPlan, collection, profile_document);
        } else {
          var ignored = false;
          for (var i in IGNORED_COMMANDS) {
            var ignored_command = IGNORED_COMMANDS[i];
            if (command[ignored_command]) {
              ignored = true;
            }
          }
          if (!ignored) {
            var key;
            if (command instanceof Object) {
              key = JSON.stringify(Object.keys(command).sort());
            } else {
              key = command;
            }
            unknown_command_keys[key] = true;
          }
        }
        break;

      default:
        if (IGNORED_OPERATORS.indexOf(profile_document.op) === -1) {
          unknown_operators[profile_document.op] = true;
        }
        break;
    }

  });

  print("INNEFFICIENT SORT QUERIES:");
  printjson(Object.keys(inefficient_sort_queries)
    .map(function(query_string) {
      return inefficient_sort_queries[query_string];
    })
    .sort(function(a, b) {
      return a.mem_usage - b.mem_usage;
    })
  );

  print("INNEFFICIENT IXSCAN QUERIES:");
  printjson(Object.keys(inefficient_ixscan_queries)
    .map(function(query_string) {
      return inefficient_ixscan_queries[query_string];
    }).sort(function(a, b) {
      return a.surplus_scans - b.surplus_scans;
    })
  );

  print("COLLSCAN QUERIES:");
  printjson(Object.keys(collscan_queries)
    .map(function(query_string) {
      return collscan_queries[query_string];
    }).sort(function(a, b) {
      return a.n_scanned - b.n_scanned;
    })
  );

  print("INDEXES_USED:");
  printjson(index_use_counts);

  if (DEBUG) {
    if (Object.keys(unknown_operators).length) {
      print("UNHANDLED OPERATORS FOUND:", JSON.stringify(Object.keys(unknown_operators)));
    }
    if (Object.keys(unknown_command_keys).length) {
      print("UNHANDLED COMMAND OPERATORS FOUND:", JSON.stringify(Object.keys(unknown_command_keys)));
    }
    if (Object.keys(collections_with_missing_info).length) {
      print("COLLECTIONS WHERE SOME QUERIES COULD NOT BE ANALYZED:", JSON.stringify(Object.keys(collections_with_missing_info)));
    }
  }
};

