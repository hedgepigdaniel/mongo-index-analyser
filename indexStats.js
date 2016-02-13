

DB.prototype.indexStats = function() {
	var BATCH_SIZE = 100;
	var DEBUG = true;
	var database = db.getName();

	var unknown_operators = {};
	var unknown_command_keys = {};

	var index_use_counts = {};
	var unindexed_queries = {};

	var collections_with_summarized_info = {};

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
				index_use_counts[collection][index.name] = 0;
			}
		}
	};

	var updateIndexCounts = function(exec_stats, collection_name, profile_document) {

		if (exec_stats.stage === "IXSCAN" || exec_stats.stage === "COUNT_SCAN" || exec_stats.stage === "IDHACK") {
			// An index was used
			var index_name;
			if (exec_stats.stage === "IDHACK") {
				index_name = "_id_";
			} else {
				index_name = exec_stats.indexName
			}
			if (!index_use_counts[collection_name]) {
				index_use_counts[collection_name] = {};
			}
			if (!index_use_counts[collection_name][index_name]) {
				index_use_counts[collection_name][index_name] = 0;
			}
			index_use_counts[collection_name][index_name]++;
		} else if (exec_stats.stage === "COLLSCAN" || exec_stats.stage === "SORT") {
			// An index was not used
			var query_string = JSON.stringify(profile_document);
			unindexed_queries[query_string] = true;
		} else if (exec_stats.stage == "FETCH" ||
				exec_stats.stage == "SUBPLAN" ||
				exec_stats.stage == "OR" ||
				exec_stats.stage == "CACHED_PLAN" ||
				exec_stats.stage == "COUNT" ||
				exec_stats.stage == "LIMIT" ||
				exec_stats.stage == "PROJECTION" ||
				exec_stats.stage == "UPDATE" ||
				exec_stats.stage == "SKIP") {
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
			collections_with_summarized_info[collection_name] = true;
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
				var collection = collectionNameFromProfileDocument(profile_document);
				updateIndexCounts(profile_document.execStats, collection, profile_document);
				break;

			case "update":
				var collection = collectionNameFromProfileDocument(profile_document);
				var explain = db[collection].explain().update(profile_document.query, profile_document.updateobj);
				updateIndexCounts(explain.queryPlanner.winningPlan, collection, profile_document);
				break;

			case "command":
				var command = profile_document.command;
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
					var explain = db[collection].explain().find(command.query);
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
					// Unhandled command
					unknown_command_keys[JSON.stringify(Object.keys(command).sort())] = true;
				}
				break;

			default:
				unknown_operators[profile_document.op] = true;
				break;
		}

	});

	if (DEBUG) {
		if (Object.keys(unknown_operators).length) {
			print("UNHANDLED OPERATORS FOUND:", JSON.stringify(Object.keys(unknown_operators)));
		}
		if (Object.keys(unknown_command_keys).length) {
			print("UNHANDLED COMMAND OPERATORS FOUND:", JSON.stringify(Object.keys(unknown_command_keys)));
		}
		if (Object.keys(collections_with_summarized_info).length) {
			print("COLLECTIONS WHERE SOME QUERIES COULD NOT BE ANALYZED:", JSON.stringify(Object.keys(collections_with_summarized_info)));
		}
	}

	print("UNINDEXED QUERIES:");
	printjson(Object.keys(unindexed_queries));

	print("INDEXES_USED:");
	printjson(index_use_counts);
};