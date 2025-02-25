// Copyright (c) 2021, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt

frappe.provide("erpnext.vehicles");

erpnext.vehicles.VehicleReceiptController = erpnext.vehicles.VehicleTransactionController.extend({
	refresh: function () {
		this._super();
		this.show_stock_ledger();
	},

	setup_queries: function () {
		this._super();

		var me = this;
		this.frm.set_query("vehicle", function () {
			var filters = {};

			if (cint(me.frm.doc.is_return)) {
				filters['warehouse'] = ['is', 'set'];
				filters['purchase_document_no'] = ['is', 'set'];
			} else {
				filters['warehouse'] = ['is', 'not set'];
			}

			if (me.frm.doc.supplier) {
				filters['supplier'] = ['in', ['', me.frm.doc.supplier]];
			}

			return {
				filters: filters
			}
		});

		this.frm.set_query("vehicle_booking_order", function() {
			var filters = {};

			if (cint(me.frm.doc.is_return)) {
				filters['delivery_status'] = 'In Stock';
			} else {
				filters['delivery_status'] = 'Not Received';
			}

			filters['status'] = ['!=', 'Cancelled Booking'];
			filters['docstatus'] = 1;

			return {
				filters: filters
			};
		});
	},
});

$.extend(cur_frm.cscript, new erpnext.vehicles.VehicleReceiptController({frm: cur_frm}));
