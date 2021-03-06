# Copyright 2013 Kevin Reid <kpreid@switchb.org>
# 
# This file is part of ShinySDR.
# 
# ShinySDR is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# ShinySDR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

from __future__ import absolute_import, division

import json
import urlparse

from twisted.trial import unittest
from twisted.internet import reactor
from twisted.web import http

from shinysdr.values import ExportedState, BlockCell, CollectionState, exported_value, setter
# TODO: StateStreamInner is an implementation detail; arrange a better interface to test
from shinysdr.web import StateStreamInner, listen
from shinysdr.test import testutil


class TestWebSite(unittest.TestCase):
	def setUp(self):
		# TODO: arrange so we don't need to pass as many bogus strings
		(self.__stop, self.url) = listen(
			{
				'httpPort': 'tcp:0',
				'wsPort': 'tcp:0',
				'rootCap': 'ROOT',
				'databasesDir': 'NONEXISTENT_PATH',
			},
			SiteStateStub(),
			_noop)
	
	def tearDown(self):
		return self.__stop()
	
	def test_app_redirect(self):
		url_without_slash = self.url[:-1]
		
		def callback((response, data)):
			self.assertEqual(response.code, http.MOVED_PERMANENTLY)
			self.assertEqual(self.url,
				urlparse.urljoin(url_without_slash,
					'ONLYONE'.join(response.headers.getRawHeaders('Location'))))
		
		return testutil.http_get(reactor, url_without_slash).addCallback(callback)


def _noop(): pass


class SiteStateStub(ExportedState):
	pass


class StateStreamTestCase(unittest.TestCase):
	def setUp(self):
		self.updates = []
		
		def send(value):
			self.updates.extend(json.loads(value))
		
		self.stream = StateStreamInner(send, self.object, 'urlroot')
	
	def getUpdates(self):
		self.stream.poll()
		u = self.updates
		self.updates = []
		return u


class TestStateStream(StateStreamTestCase):
	def setUp(self):
		self.object = StateSpecimen()
		StateStreamTestCase.setUp(self)
	
	def test_init_mutate(self):
		self.assertEqual(self.getUpdates(), [
			['register_block', 1, 'urlroot'],
			['register_cell', 2, 'urlroot/rw', self.object.state()['rw'].description()],
			['value', 1, {'rw': 2}],
			['value', 0, 1],
		])
		self.assertEqual(self.getUpdates(), [])
		self.object.set_rw(2.0)
		self.assertEqual(self.getUpdates(), [
			['value', 2, self.object.get_rw()],
		])


class StateSpecimen(ExportedState):
	'''Helper for TestStateStream'''
	def __init__(self):
		self.rw = 1.0
	
	@exported_value(ctor=float)
	def get_rw(self):
		return self.rw
	
	@setter
	def set_rw(self, value):
		self.rw = value


class TestCollectionStream(StateStreamTestCase):
	def setUp(self):
		self.d = {'a': ExportedState()}
		self.object = CollectionState(self.d, dynamic=True)
		StateStreamTestCase.setUp(self)
	
	def test_delete(self):
		self.assertEqual(self.getUpdates(), [
			['register_block', 1, 'urlroot'],
			['register_cell', 2, 'urlroot/a', self.object.state()['a'].description()],
			['register_block', 3, 'urlroot/a'],
			['value', 3, {}],
			['value', 2, 3],
			['value', 1, {'a': 2}],
			['value', 0, 1],
		])
		self.assertEqual(self.getUpdates(), [])
		del self.d['a']
		self.assertEqual(self.getUpdates(), [
			['value', 1, {}],
			['delete', 2],
			['delete', 3],
		])
