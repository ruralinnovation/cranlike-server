/* Packages */
const express = require('express');
const createError = require('http-errors');
const multer  = require('multer')
const md5file = require('md5-file');
const rdesc = require('rdesc-parser');
const fs = require('fs');

/* Local variables */
const upload = multer({ dest: '/tmp/' })
const router = express.Router();

/* Error generator */
function error_cb(status, next) {
	return function(err) {
		next(createError(status, err));
	}
}

//Remove file from bucket if there are no more references to it
function delete_file(MD5sum){
	return packages.findOne({MD5sum : MD5sum}).then(function(doc){
		if(doc){
			console.log("Found other references, not deleting file: " + MD5sum);
		} else {
			bucket.delete(MD5sum).then(function(){
				console.log("Deleted file " + MD5sum);
			}, function(err){
				console.log("Failed to delete " + MD5sum + ": " + err);
			});
		}
	});
}

/* Routers */
router.get('/', function(req, res, next) {
	packages.distinct('_user').then(function(x){
		res.send(x);
	}).catch(error_cb(400, next));
});

router.get('/:user', function(req, res, next) {
	packages.distinct('Package', {_user : req.params.user}).then(function(x){
		res.send(x);
	}).catch(error_cb(400, next));
});

router.get('/:user/:package', function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package
	packages.distinct('Version', {_user : user, Package : package}).then(function(x){
		res.send(x);
	}).catch(error_cb(400, next));
});

router.get('/:user/:package/:version', function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package
	var version = req.params.version;
	packages.find({_user : user, Package : package, Version : version}).toArray().then(function(docs){
		res.send(docs);
	}).catch(error_cb(400, next));
});

router.delete('/:user/:package/:version?/:type?', function(req, res, next){
	var user = req.params.user;
	var package = req.params.package;
	var query = {_user: req.params.user, Package: req.params.package};
	if(req.params.version)
		query.Version = req.params.version
	if(req.params.type)
		query._type = req.params.type;
	packages.find(query).project({_id:1, MD5sum:1,}).toArray().then(function(docs){
		var promises = docs.map(function(doc){
			return packages.deleteOne({_id: doc['_id']}).then(function(){
				return delete_file(doc.MD5sum);
			});
		});
		Promise.all(promises).then(function(){
			res.send(docs);
		});
	}).catch(error_cb(400, next));
});

router.post('/:user/:package/:version', upload.fields([{ name: 'file', maxCount: 1 }]), function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package;
	var version = req.params.version;
	var type = req.body.type;
	if(['src', 'win', 'mac'].indexOf(type) < 0){
		next(createError(400, "Parameter 'type' must be one of src, win, mac"));
	} else if(!req.files.file || !req.files.file[0]){
		next(createError(400, "Missing parameter 'file' in upload"));
	} else {
		var filepath = req.files.file[0].path;
		var filename = req.files.file[0].originalname;
		rdesc.parse_file(filepath, function(err, data) {
			if(err){
				next(createError(400, err));
			} else if(data.Package != package || data.Version != version) {
				next(createError(400, 'Package name or version does not match upload'));
			} else { 
				if(type == 'src' && data.Built) {
					next(createError(400, 'Source package has a "built" field (binary pkg?)'));
				} else if((type == 'win' || type == 'mac') && !data.Built) {
					next(createError(400, 'Binary package is does not have valid Built field'));
				} else if(type == 'win' && data.Built.OStype != 'windows') {
					next(createError(400, 'Windows Binary package has unexpected OStype:' + data.Built.OStype));
				} else if(type == 'mac' && data.Built.OStype != 'unix') {
					next(createError(400, 'MacOS Binary package has unexpected OStype:' + data.Built.OStype));
				} else if(type == 'mac' && data.Built.Platform && !data.Built.Platform.match('apple')) {
					//Built.Platform is missing for binary pkgs without copiled code
					next(createError(400, 'MacOS Binary package has unexpected Platform:' + data.Built.Platform));
				} else {
					const MD5sum = md5file.sync(filepath);
					bucket.delete(MD5sum).then(function(){
						console.log("Replacing previous file " + MD5sum);
					}, function(err){
						console.log("New file " + MD5sum);
					}).finally(function(){
						fs.createReadStream(filepath).on('end', function(){
							fs.unlink(filepath, function(){
								console.log("Deleted tempfile: " + filepath);
							});
						}).pipe(bucket.openUploadStreamWithId(MD5sum, filename)).on('error', function(err) {
							next(createError(400, err));
						}).on('finish', function() {
							data['_user'] = user;
							data['_type'] = type;
							data['MD5sum'] = MD5sum;
							data['_file'] = filename;
							data['_published'] = new Date();

							/* Currently replace the pervious version of the pkg */
							/* If we keep old versions, the index functions need to filter only the newest submission for each pkg */
							/* This would replace only upload with the same version */
							//var filter = {_user : user, _type : type, Package : package, Version : version};

							/* Replace any other version of the package */
							var filter = {_user : user, _type : type, Package : package};
							packages.findOneAndReplace(filter, data, {upsert: true, returnOriginal: true}).then(function(result) {
								var original = result.value;
								if(original){
									delete_file(original['MD5sum']).finally(function(){
										res.send("Succesfully replaced " + filename + '\n');
									});
								} else {
									res.send("Succesfully uploaded " + filename + '\n');
								}
							}).catch(error_cb(400, next));
						});
					});
				}
			}
		});
	}
});

module.exports = router;